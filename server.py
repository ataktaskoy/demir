from flask import Flask, request, jsonify, send_from_directory, redirect, url_for, render_template, make_response
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
import jwt 
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
from datetime import datetime, timedelta

# --- Uygulama ve Veritabanı Yapılandırması ---
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Veritabanı Ayarları (SQLite kullanıyoruz)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'default_secret_key_lutfen_degistir')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///site.db') 
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# API Anahtarı
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

# --- Veritabanı Modelleri ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(500), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    is_active_member = db.Column(db.Boolean, default=False) # Ücretli üye/tam üye
    demo_chat_count = db.Column(db.Integer, default=5) # Demo chat hakkı
    date_joined = db.Column(db.DateTime, default=datetime.utcnow)

class Chat(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    message = db.Column(db.Text, nullable=False)
    role = db.Column(db.String(10), nullable=False) # 'user' veya 'assistant'
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    user = db.relationship('User', backref=db.backref('chats', lazy=True))

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- KRİTİK Veritabanı Başlatma ---
# Gunicorn altında dahi çalışması için app context'i burada çağırıyoruz.
with app.app_context():
    db.create_all()

# --- ADMIN PANELİ FONKSİYONLARI ---

# Admin girişi için statik bilgiler (GERÇEKTE VERİTABANINDAN OKUNMALIDIR)
ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
# Lütfen KENDİ hash'inizi buraya veya Render ENV'ye ekleyin.
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', 'pbkdf2:sha256:600000$Qy1d$6f68e0d440c2621f8a85f261906f36d4')

def admin_required(f):
    """Admin yetkisi gerektiren dekoratör."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_token = request.cookies.get('admin_token')
        if not admin_token:
            return redirect(url_for('admin_login', next=request.url))
        
        try:
            # Token'ı doğrula
            data = jwt.decode(admin_token, app.config['SECRET_KEY'], algorithms=['HS256'])
            if data.get('username') != ADMIN_USERNAME:
                raise Exception("Yetkisiz kullanıcı.")
            
        except jwt.ExpiredSignatureError:
            return redirect(url_for('admin_login', error="Oturum süresi doldu."))
        except Exception:
            return redirect(url_for('admin_login', error="Geçersiz yetkilendirme."))
            
        return f(*args, **kwargs)
    return decorated_function

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    """Admin Giriş Sayfası"""
    error = request.args.get('error')
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        if username == ADMIN_USERNAME and check_password_hash(ADMIN_PASSWORD_HASH, password):
            # 1 saat süreli admin token'ı oluştur
            token_payload = {
                'username': ADMIN_USERNAME,
                'exp': datetime.utcnow() + timedelta(hours=1)
            }
            token = jwt.encode(token_payload, app.config['SECRET_KEY'], algorithm='HS256')
            
            response = redirect(url_for('admin_panel'))
            response.set_cookie('admin_token', token, httponly=True, secure=True if 'https' in request.url else False, samesite='Lax')
            return response
        else:
            error = "Hatalı Kullanıcı Adı veya Şifre."
            
    return render_template('login.html', is_admin_login=True, error=error)


@app.route('/admin/panel')
@admin_required
def admin_panel():
    """Admin Ana Paneli"""
    return render_template('admin.html') # admin.html panelini döndürür

@app.route('/admin/logout')
def admin_logout():
    """Admin Oturumu Kapatma"""
    response = redirect(url_for('admin_login'))
    response.set_cookie('admin_token', '', expires=0, httponly=True, secure=True if 'https' in request.url else False, samesite='Lax')
    return response

@app.route('/api/admin/users', methods=['GET'])
@admin_required
def get_users():
    """Tüm kullanıcı listesini döndürür."""
    users = User.query.all()
    user_list = []
    for user in users:
        user_list.append({
            'id': user.id,
            'username': user.username,
            'email': user.email,
            'is_active_member': user.is_active_member,
            'demo_chat_count': user.demo_chat_count,
            'date_joined': user.date_joined.strftime('%Y-%m-%d %H:%M:%S')
        })
    return jsonify({'users': user_list})

@app.route('/api/admin/toggle', methods=['POST'])
@admin_required
def toggle_membership():
    """Kullanıcının üyelik durumunu (aktif/demo) değiştirir."""
    data = request.get_json()
    username = data.get('username')
    action = data.get('action') # 'activate' veya 'deactivate'

    if not username or action not in ['activate', 'deactivate']:
        return jsonify({'error': 'Geçersiz veri.'}), 400

    user = User.query.filter_by(username=username).first()
    if not user:
        return jsonify({'error': 'Kullanıcı bulunamadı.'}), 404

    try:
        if action == 'activate':
            user.is_active_member = True
            user.demo_chat_count = 9999999
            message = f"Kullanıcı '{username}' üyeliği başarıyla AKTİF edildi."
        else:
            user.is_active_member = False
            user.demo_chat_count = 5 # Demo yapınca hakkı sıfırlansın
            message = f"Kullanıcı '{username}' üyeliği DEMO durumuna çevrildi ve hakkı 5'e sıfırlandı."
        
        db.session.commit()
        return jsonify({'message': message, 'is_active': user.is_active_member})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': 'Veritabanı hatası: ' + str(e)}), 500


# --- KULLANICI GİRİŞ/KAYIT ROTLARI ---

@app.route('/register', methods=['GET', 'POST'])
def register():
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        
        if User.query.filter_by(username=username).first():
            error = "Bu kullanıcı adı zaten mevcut."
        elif User.query.filter_by(email=email).first():
            error = "Bu e-posta adresi zaten kayıtlı."
        else:
            try:
                hashed_password = generate_password_hash(password, method='pbkdf2:sha256')
                new_user = User(username=username, email=email, password_hash=hashed_password)
                db.session.add(new_user)
                db.session.commit()
                login_user(new_user)
                return redirect(url_for('index'))
            except Exception as e:
                db.session.rollback()
                error = "Kayıt sırasında bir hata oluştu: " + str(e)

    return render_template('login.html', is_register=True, error=error)

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        user = User.query.filter_by(username=username).first()
        
        if user and check_password_hash(user.password_hash, password):
            login_user(user)
            return redirect(url_for('index'))
        else:
            error = "Hatalı Kullanıcı Adı veya Şifre."
            
    return render_template('login.html', is_register=False, error=error)

@app.route('/logout')
@login_required
def logout():
    """Oturumu kapatır ve ana sayfaya yönlendirir."""
    logout_user()
    return redirect(url_for('index'))

@app.route('/profile')
@login_required
def profile():
    """Kullanıcının profil ve chat geçmişi sayfası."""
    # Chat geçmişini al (son 20 mesaj)
    chat_history = Chat.query.filter_by(user_id=current_user.id)\
                            .order_by(Chat.timestamp.desc())\
                            .limit(20).all()
    # Geçmişi en eskiden en yeniye doğru sırala
    chat_history.reverse()
    
    return render_template('profile.html', user=current_user, chat_history=chat_history)

@app.route('/api/profile')
@login_required
def api_profile():
    """JavaScript'in kullanıcı durumunu kontrol etmesi için API endpoint'i."""
    return jsonify({
        'is_authenticated': True,
        'username': current_user.username,
        'is_active_member': current_user.is_active_member,
        'demo_chat_count': current_user.demo_chat_count,
        'date_joined': current_user.date_joined.strftime('%Y-%m-%d')
    })

# --- ANA BOT VE SES ROTLARI ---

@app.route('/')
def index():
    if not current_user.is_authenticated:
        return redirect(url_for('login'))
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/ask', methods=['POST'])
@login_required
def ask():
    if not OPENROUTER_API_KEY:
        return jsonify({"error": "OPENROUTER_API_KEY ortam değişkeni ayarlanmamış."}), 500

    if not current_user.is_active_member and current_user.demo_chat_count <= 0:
        return jsonify({
            "error": "Demo hakkınız sona erdi. Tam üyelik için admin ile iletişime geçin.",
            "code": "LIMIT_REACHED"
        }), 403

    try:
        user_message = request.json.get('message')
        if not user_message:
            return jsonify({"error": "Mesaj boş olamaz."}), 400

        # Veritabanına kullanıcı mesajını kaydet
        user_chat = Chat(user_id=current_user.id, message=user_message, role='user')
        db.session.add(user_chat)
        db.session.commit()

        # Chat geçmişini OpenAI formatına çevir
        history = Chat.query.filter_by(user_id=current_user.id)\
                            .order_by(Chat.timestamp.asc())\
                            .limit(10).all() 

        messages = [{"role": "system", "content": "Sen, Demir adında bir öğrenciye derslerinde yardımcı olan, sabırlı ve neşeli bir yapay zeka öğretmenisin. Cevapların kısa, net ve öğrencinin seviyesine uygun olmalıdır."}]
        for chat in history:
            messages.append({"role": chat.role, "content": chat.message})

        # API Çağrısı
        response = openai.chat.completions.create(
            model="openai/gpt-3.5-turbo", # OpenRouter'daki modeli kullan
            messages=messages,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "HTTP-Referer": request.url 
            }
        )
        bot_response = response.choices[0].message.content

        # Veritabanına bot mesajını kaydet
        bot_chat = Chat(user_id=current_user.id, message=bot_response, role='assistant')
        db.session.add(bot_chat)
        
        # Demo hakkını düşür (tam üye değilse)
        if not current_user.is_active_member:
            current_user.demo_chat_count -= 1
        
        db.session.commit()

        return jsonify({
            "response": bot_response,
            "demo_chat_count": current_user.demo_chat_count,
            "is_active_member": current_user.is_active_member
        })

    except Exception as e:
        db.session.rollback()
        logging.error(f"API/Chat hatası: {str(e)}")
        return jsonify({"error": "API çağrılırken bir hata oluştu."}), 500

@app.route('/tts', methods=['POST'])
@login_required
def tts():
    if not current_user.is_active_member and current_user.demo_chat_count < 0:
         return jsonify({"error": "Demo hakkı TTS için kullanılamaz."}), 403

    try:
        text = request.json.get('text')
        if not text:
            return jsonify({"error": "Seslendirilecek metin boş olamaz."}), 400

        # Edge-TTS komutunu oluştur
        temp_dir = tempfile.gettempdir()
        # Her istek için benzersiz bir dosya adı oluşturun
        output_filename = os.path.join(temp_dir, f"tts_{os.getpid()}_{time.time()}.mp3")
        
        # Seçilen ses (Türkçe)
        voice = "tr-TR-Ankara-NehirNeural" 
        
        # TTS komutu
        command = [
            'edge-tts',
            '--text', text,
            '--voice', voice,
            '--rate', '+10%',
            '--output-file', output_filename
        ]

        # Komutu çalıştırma
        process = subprocess.run(command, check=True, capture_output=True, text=True)

        if process.returncode != 0:
             logging.error(f"Edge-TTS hatası (Stderr): {process.stderr}")
             return jsonify({"error": "Ses sentezlenemedi."}), 500

        # Oluşturulan MP3 dosyasını oku ve Base64 olarak gönder
        with open(output_filename, 'rb') as f:
            mp3_data = f.read()
        
        base64_mp3 = base64.b64encode(mp3_data).decode('utf-8')
        
        # Geçici dosyayı sil
        os.remove(output_filename)

        return jsonify({"audio": base64_mp3})

    except subprocess.CalledProcessError as e:
        logging.error(f"TTS Subprocess Hatası: {e.stderr}")
        return jsonify({"error": "Ses sentezi aracı çalıştırılamadı."}), 500
    except Exception as e:
        logging.error(f"TTS Genel Hata: {str(e)}")
        return jsonify({"error": "Ses sentezi sırasında beklenmeyen bir hata oluştu."}), 500
    
if __name__ == '__main__':
    # Gunicorn kullanıldığı için bu blok Render'da çalışmaz, ancak yerel test için bırakılmıştır.
    # db.create_all() yukarıda, app context içinde garanti edildi.
    app.run(debug=True, host='0.0.0.0', port=10000)