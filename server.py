from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
import openai
import base64
import logging
import os
import subprocess
import tempfile
import json # JSON'u düzgün işlemek için
import time 

# --- Uygulama ve Veritabanı Yapılandırması ---
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Veritabanı Ayarları (SQLite kullanıyoruz)
app.config['SECRET_KEY'] = 'sizin_guclu_bir_gizli_anahtariniz_burada_olmali'
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///site.db') # Render'da PostgreSQL kullanabilir, yerelde sqlite
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# API Anahtarı
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

# --- Veritabanı Modelleri ---
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    name = db.Column(db.String(80), nullable=True) # Demir'in adı
    grade = db.Column(db.Integer, nullable=True) # Sınıfı
    conversations = db.relationship('Conversation', backref='user', lazy=True)

class Conversation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    role = db.Column(db.String(10), nullable=False) # 'user' veya 'assistant'
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

# Uygulama bağlamı içinde veritabanı tablolarını oluştur.
with app.app_context():
    db.create_all()

# --- Statik Rotalar ---
@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/favicon.ico")
def favicon():
    return send_from_directory("static", "favicon.ico")


# --- API Rotası ---
@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    question = data.get("message", "")
    # Şimdilik kullanıcı ID'sini varsayılan olarak 1 (Demir) alıyoruz.
    # Authentication eklendiğinde bu dinamikleşecek.
    user_id = 1 
    
    logging.info(f"Gelen soru (User {user_id}): {question}")
    
    if not OPENROUTER_API_KEY:
        return jsonify({"error": "Sunucu API anahtarı eksik."}), 500
    
    # 1. Kullanıcı ve Hafıza Yönetimi
    # Kullanıcıyı bul (varsayılan)
    user = db.session.get(User, user_id)
    if not user:
        # Eğer varsayılan kullanıcı yoksa, oluşturalım (Sadece başlangıç için)
        user = User(username='demir', name='Demir', grade=6)
        db.session.add(user)
        db.session.commit()
    
    # Yeni kullanıcı mesajını DB'ye kaydet
    new_message = Conversation(user_id=user_id, role='user', content=question)
    db.session.add(new_message)
    db.session.commit()
    
    # Geçmişi al (son 10 mesaj)
    history = Conversation.query.filter_by(user_id=user_id)\
        .order_by(Conversation.timestamp.desc())\
        .limit(10)\
        .all()
    
    # En eski mesajdan en yeniye sırala
    history.reverse()

    # Sisteme gönderilecek mesaj listesini oluştur
    messages = []
    
    # Kullanıcının profilini System Prompt'a ekle
    user_prompt_info = f"Adı: {user.name or 'Bilinmiyor'}, Sınıfı: {user.grade or 'Bilinmiyor'}. Şu anki kullanıcın bu."
    
    system_prompt = (
        f"Sen, {user.name or 'Demir'}'in **özel, çok neşeli ve sohbet etmeyi seven** bir yapay zeka öğretmenisin. "
        "Rolün, Demir'in tüm ödevlerinde ve derslerinde ona yardımcı olmak, ancak **ASLA DOĞRUDAN CEVABI VERMEMEK**. "
        f"{user_prompt_info} Geriye dönük sohbeti hatırlamalısın."
        "Cevap verme felsefen şunlara dayanır: "
        "1. **Muhabbet Tonu:** Yanıtların son derece samimi ve neşeli olsun. Sanki Demir'in en sevdiği ablası/abisi gibi konuş. "
        "2. **Teşvik ve Neşe:** Cevaba her zaman coşkulu bir giriş veya motive edici bir ifadeyle başla. (Örn: 'Vay canına, bu çok heyecan verici bir soru! Hadi birlikte bakalım.') "
        "3. **Sokratik Yöntem:** Cevap vermek yerine, Demir'e **bir sonraki adımı bulması için yönlendirici, temel bir kuralı hatırlatan veya konuyu çağrıştıran BİR SORU** sor. "
        "4. **Zorlama ve İlerleme:** İpuçları küçük olmalı ve 'Haydi, şimdi bu ipucuyla tekrar dene!' veya 'Buna eminim sen de ulaşırsın!' gibi zorlayıcı/teşvik edici ifadelerle bitmeli. "
        "5. **Ses Uyumu (Çok Önemli):** Metinlerinde **ASLA emoji veya özel karakter kullanma**. Sadece doğal duraklamalar ve akıcı bir ses tonu için virgül (,) ve nokta (.) kullan. Yanıtların kısa ve seslendirmeye uygun olsun."
    )
    
    messages.append({"role": "system", "content": system_prompt})
    
    # Geçmişi messages listesine ekle
    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})


    try:
        # 2. Metin Cevabını Alma (OpenRouter - Claude 3.5 Sonnet)
        client_openai = openai.OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
        completion = client_openai.chat.completions.create(
            model="anthropic/claude-3-5-sonnet", 
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
            logging.info("Edge TTS ile ses üretiliyor (Hız: +5%)...")
            
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+5%" 
            
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
    # Geliştirme modunda (debug=True) sadece ana sunucu çalışır
    # Render'da gunicorn kullanılır.
    app.run(debug=True)