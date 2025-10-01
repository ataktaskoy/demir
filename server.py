from flask import Flask, request, jsonify, send_from_directory, redirect, url_for, render_template
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin, LoginManager, login_user, logout_user, current_user, login_required
import openai
import base64
import logging
import os
import subprocess
import tempfile
import json
import time 
from werkzeug.security import generate_password_hash, check_password_hash

# --- Uygulama ve Veritabanı Yapılandırması ---
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Veritabanı Ayarları (SQLite kullanıyoruz)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'default_secret_key_lutfen_degistir') # Güvenlik için ortam değişkeni kullanılmalı
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///site.db') 
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login' # Giriş yapılmamış kullanıcıyı yönlendireceği sayfa

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# API Anahtarı
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

# --- Flask-Login Kullanıcı Yükleyici ---
@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))

# --- Veritabanı Modelleri ---
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    # Öğrenci Bilgileri (Kalıcı Hafıza)
    name = db.Column(db.String(80), nullable=True) 
    grade = db.Column(db.Integer, nullable=True) 
    conversations = db.relationship('Conversation', backref='user', lazy=True)
    
    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Conversation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    role = db.Column(db.String(10), nullable=False) # 'user' veya 'assistant'
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

# Uygulama bağlamı içinde veritabanı tablolarını oluştur.
with app.app_context():
    db.create_all()
    # Başlangıçta Demir kullanıcısını ve bir Admin kullanıcısını oluştur (varsa atla)
    if not db.session.get(User, 1):
        admin_user = User(username='admin', is_admin=True)
        admin_user.set_password('admin123') # Lütfen bu şifreyi değiştirin!
        db.session.add(admin_user)
        
        demir_user = User(username='demir', name='Demir', grade=6, is_admin=False)
        demir_user.set_password('demir123') # Lütfen bu şifreyi değiştirin!
        db.session.add(demir_user)
        db.session.commit()


# --- Rotalar (Giriş/Çıkış ve Ana Sayfa) ---
# Ana sayfa: Giriş yapılmamışsa login'e yönlendirir.
@app.route("/")
@login_required # Giriş yapılmasını zorunlu kılar
def index():
    return send_from_directory("static", "index.html")

@app.route("/favicon.ico")
def favicon():
    return send_from_directory("static", "favicon.ico")

@app.route("/login", methods=['GET', 'POST'])
def login():
    # Bu kısmı daha sonra geliştireceğimiz login.html'e bağlayacağız
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user)
            # Giriş başarılıysa ana sayfaya yönlendir
            return redirect(url_for('index')) 
        else:
            return "Hatalı Kullanıcı Adı veya Şifre", 401
    
    # Şimdilik basit bir giriş formu döndür
    return """
        <form method="post">
            <input type="text" name="username" placeholder="Kullanıcı Adı" required><br>
            <input type="password" name="password" placeholder="Şifre" required><br>
            <input type="submit" value="Giriş Yap">
        </form>
    """
    
@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# --- API Rotası ---
@app.route("/ask", methods=["POST"])
@login_required # Sadece giriş yapan kullanıcılar kullanabilir
def ask():
    data = request.get_json()
    question = data.get("message", "")
    user_id = current_user.id # Giriş yapan kullanıcının ID'sini al
    
    logging.info(f"Gelen soru (User {user_id}): {question}")
    
    if not OPENROUTER_API_KEY:
        return jsonify({"error": "Sunucu API anahtarı eksik."}), 500
    
    # 1. Kullanıcı ve Hafıza Yönetimi
    user = current_user # Giriş yapan kullanıcı zaten elimizde
    
    # Yeni kullanıcı mesajını DB'ye kaydet
    new_message = Conversation(user_id=user_id, role='user', content=question)
    db.session.add(new_message)
    db.session.commit()
    
    # Geçmişi al (son 25 mesaj - İnsancıl hafıza penceresi)
    history = Conversation.query.filter_by(user_id=user_id)\
        .order_by(Conversation.timestamp.desc())\
        .limit(25)\
        .all()
    
    # En eski mesajdan en yeniye sırala
    history.reverse()

    # Sisteme gönderilecek mesaj listesini oluştur
    messages = []
    
    # --- KALICI VE GEÇİCİ HAFIZA BÖLÜMLERİ ---

    # A) KALICI HAFIZA (Permanent Facts)
    permanent_facts = (
        f"Kullanıcının adı {user.name or 'Bilinmiyor'} ve {user.grade or 'Bilinmiyor'}. sınıfa gidiyor. "
        "Bu temel bilgileri ASLA unutma ve her zaman hitabında kullan."
    )

    # B) SİSTEM ROLÜ (System Role)
    system_role_prompt = (
        f"Sen, {user.name or 'Öğrencin'}'in **özel, çok neşeli ve sohbet etmeyi seven** bir yapay zeka öğretmenisin. "
        "Rolün, öğrencinin tüm ödevlerinde ve derslerinde ona yardımcı olmak, ancak **ASLA DOĞRUDAN CEVABI VERMEMEK**. "
        "Cevap verme felsefen şunlara dayanır: "
        "1. **Muhabbet Tonu:** Yanıtların son derece samimi ve neşeli olsun. Sanki öğrencinin en sevdiği ablası/abisi gibi konuş. "
        "2. **Teşvik ve Neşe:** Cevaba her zaman coşkulu bir giriş veya motive edici bir ifadeyle başla. (Örn: 'Vay canına, bu çok heyecan verici bir soru! Hadi birlikte bakalım.') "
        "3. **Sokratik Yöntem:** Cevap vermek yerine, öğrenciye **bir sonraki adımı bulması için yönlendirici, temel bir kuralı hatırlatan veya konuyu çağrıştıran BİR SORU** sor. "
        "4. **Zorlama ve İlerleme:** İpuçları küçük olmalı ve 'Haydi, şimdi bu ipucuyla tekrar dene!' veya 'Buna eminim sen de ulaşırsın!' gibi zorlayıcı/teşvik edici ifadelerle bitmeli. "
        "5. **Ses Uyumu (Çok Önemli):** Metinlerinde **ASLA emoji veya özel karakter kullanma**. Sadece doğal duraklamalar ve akıcı bir ses tonu için virgül (,) ve nokta (.) kullan. Yanıtların kısa ve seslendirmeye uygun olsun."
    )

    # C) FULL SYSTEM PROMPT: Kalıcı Gerçekler + Sistem Rolü
    full_system_prompt = permanent_facts + " Ayrıca geriye dönük son konuşmayı hatırlamalısın." + system_role_prompt

    messages.append({"role": "system", "content": full_system_prompt})
    
    # Geçmişi messages listesine ekle
    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})


    try:
        # 2. Metin Cevabını Alma (OpenRouter - GPT-4o Mini - HIZ GARANTİLİ)
        client_openai = openai.OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
        completion = client_openai.chat.completions.create(
            # Hız ve düşük maliyet için model GPT-4o Mini olarak ayarlı
            model="openai/gpt-4o-mini", 
            messages=messages
        )
        answer = completion.choices[0].message.content

        # Yeni bot cevabını DB'ye kaydet
        new_answer = Conversation(user_id=user_id, role='assistant', content=answer)
        db.session.add(new_answer)
        db.session.commit()

        # 3. Ses Üretimi (Edge TTS)
        audio_base64 = ""
        
        try:
            logging.info("Edge TTS ile ses üretiliyor (Hız: +3%)...")
            
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+3%" # Kararlılık için düşük hız
            
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp_audio:
                temp_filename = tmp_audio.name
            
            command = [
                'edge-tts',
                '--text', answer,
                '--voice', VOICE,
                '--rate', RATE,
                '--write-media', temp_filename
            ]
            
            subprocess.run(command, check=True, capture_output=True)
            
            with open(temp_filename, 'rb') as f:
                audio_data = f.read()
            
            os.remove(temp_filename)

            audio_base64 = base64.b64encode(audio_data).decode('utf-8')

        except Exception as tts_error:
            logging.error(f"Edge TTS HATA: Ses üretilemedi. Hata: {str(tts_error)}", exc_info=True)
            pass 

        return jsonify({"answer": answer, "audio_base64": audio_base64})

    except Exception as e:
        logging.error(f"Genel hata oluştu: {str(e)}", exc_info=True)
        return jsonify({"error": "Sunucuya ulaşılamıyor. Render Kayıtlarını kontrol edin."}), 500

if __name__ == "__main__":
    app.run(debug=True)