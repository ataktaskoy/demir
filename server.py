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

# 500 HATA ÇÖZÜMÜ: SQLite dosyasını Render'da yazılabilir olan /tmp klasörüne taşıyoruz.
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'default_secret_key_lutfen_degistir')
# DİKKAT: Yeni veritabanı yolu /tmp
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:////tmp/site.db') 
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# API Anahtarı
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

# --- Flask-Login Kullanıcı Yöneticisi ---
@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# --- Veritabanı Modelleri ---
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False) 
    name = db.Column(db.String(100), nullable=True)     
    surname = db.Column(db.String(100), nullable=True)  
    phone = db.Column(db.String(20), nullable=True)     
    password_hash = db.Column(db.String(128), nullable=False)
    is_active_member = db.Column(db.Boolean, default=False)
    demo_chat_count = db.Column(db.Integer, default=5)
    grade = db.Column(db.String(50), nullable=True) 
    date_joined = db.Column(db.DateTime, default=db.func.now())
    
    chats = db.relationship('Chat', backref='author', lazy='dynamic')
    
    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Chat(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    message = db.Column(db.Text, nullable=False)
    response = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=db.func.now())

# --- KRİTİK DÜZELTME: TABLOLARIN HER ZAMAN OLUŞTURULMASINI SAĞLAMA ---
# db.create_all()'ı if __name__ == '__main__': bloğundan çıkarıp buraya taşıyoruz.
with app.app_context():
    db.create_all()
# ----------------------------------------------------------------------


# --- Rotalar ---

# Ana Sayfa Rotası (Sohbet Arayüzü)
@app.route('/')
@login_required
def index():
    return render_template('index.html')

# Statik dosyaları sunma
@app.route('/<path:filename>')
def serve_static_files(filename):
    if filename in ['index.html', 'login.html', 'register.html', 'profile.html', 'admin.html']:
        return "Not Found", 404
    return send_from_directory(app.static_folder, filename)

# Kullanıcı Giriş Rotası
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        user = User.query.filter_by(username=username).first()
        
        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for('index')) 
        else:
            return render_template('login.html', error='Kullanıcı adı veya şifre hatalı.')
    
    return render_template('login.html')

# Kullanıcı Kayıt Rotası
@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip()
        password = request.form.get('password', '')
        
        name = request.form.get('name', '').strip() 
        surname = request.form.get('surname', '').strip() 
        phone = request.form.get('phone', '').strip()

        if not username or not email or not password or not name or not surname:
            return render_template('register.html', error='İsim, Soyisim, Kullanıcı Adı, E-posta ve Şifre alanları zorunludur.')

        if User.query.filter_by(username=username).first():
            return render_template('register.html', error='Bu kullanıcı adı zaten kullanılıyor.')

        if User.query.filter_by(email=email).first():
            return render_template('register.html', error='Bu e-posta adresi zaten kullanılıyor.')

        new_user = User(
            username=username,
            email=email,
            name=name,
            surname=surname,
            phone=phone,
            is_active_member=False,
            demo_chat_count=5
        )
        new_user.set_password(password)
        
        try:
            db.session.add(new_user)
            db.session.commit()
            
            # Kayıt başarılı olduğunda Giriş sayfasına yönlendirme
            return redirect(url_for('login')) 
        except Exception as e:
            db.session.rollback()
            logging.error(f"Kayıt hatası: {str(e)}")
            return render_template('register.html', error='Veritabanına kaydederken beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.'), 500

    return render_template('register.html') 

# Çıkış Rotası
@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# Profil Sayfası Rotası
@app.route('/profile')
@login_required
def profile_page():
    return render_template('profile.html')

# API: Kullanıcı Profil Bilgilerini Çekme/Güncelleme
@app.route('/api/profile', methods=['GET', 'POST'])
@login_required
def api_profile():
    if request.method == 'GET':
        return jsonify({
            'username': current_user.username,
            'email': current_user.email,
            'name': current_user.name,
            'surname': current_user.surname,
            'phone': current_user.phone,
            'is_active_member': current_user.is_active_member,
            'demo_chat_count': current_user.demo_chat_count,
            'grade': current_user.grade or ''
        })

    elif request.method == 'POST':
        data = request.form if request.form else request.get_json()
        
        grade = data.get('grade')
        
        current_user.grade = grade
        
        try:
            db.session.commit()
            return jsonify({'message': 'Profil başarıyla güncellendi.'}), 200
        except Exception as e:
            db.session.rollback()
            logging.error(f"Profil güncelleme hatası: {str(e)}")
            return jsonify({'error': 'Profil güncellenirken bir hata oluştu.'}), 500

# Sohbet API Rotası
@app.route('/ask', methods=['POST'])
@login_required
def ask():
    if not OPENROUTER_API_KEY:
        return jsonify({"error": "OPENROUTER_API_KEY ortam değişkeni ayarlanmamış."}), 500

    if not current_user.is_active_member and current_user.demo_chat_count <= 0:
        return jsonify({
            "answer": "Demo hakkınız dolmuştur. Tüm özelliklere erişmek için lütfen tam üyeliğe geçin.", 
            "error": "Demo hakkı bitti"
        }), 402

    try:
        data = request.get_json()
        user_message = data.get("message", "").strip()

        if not user_message:
            return jsonify({"error": "Mesaj boş olamaz."}), 400
            
        user_context = f"Kullanıcının sınıfı/seviyesi: {current_user.grade if current_user.grade else 'Belirtilmemiş'}."

        client = openai.OpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
        )

        response = client.chat.completions.create(
            model="openai/gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": f"Sen AI Ödev öğretmenisin. Soruları yaşına ve sınıfına uygun, arkadaş canlısı ve eğitici bir dille yanıtla. Bağlam: {user_context}"},
                {"role": "user", "content": user_message}
            ],
        )

        answer = response.choices[0].message.content
        
        if not current_user.is_active_member:
            current_user.demo_chat_count -= 1
        
        new_answer = Chat(user_id=current_user.id, message=user_message, response=answer)
        db.session.add(new_answer)
        db.session.commit()

        # Ses Üretimi (Edge TTS)
        audio_base64 = ""
        try:
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+3%"
            
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp_audio:
                temp_filename = tmp_audio.name
            
            command = ['edge-tts', '--text', answer, '--voice', VOICE, '--rate', RATE, '--write-media', temp_filename]
            subprocess.run(command, check=True, capture_output=True)
            
            with open(temp_filename, 'rb') as f:
                audio_data = f.read()
            
            os.remove(temp_filename)
            audio_base64 = base64.b64encode(audio_data).decode('utf-8')

        except Exception as tts_error:
            logging.error(f"Edge TTS HATA: Ses üretilemedi. Hata: {str(tts_error)}")
            pass 

        return jsonify({"answer": answer, "audio_base64": audio_base64}), 200

    except Exception as e:
        db.session.rollback()
        logging.error(f"Genel API HATA: {str(e)}")
        return jsonify({"error": "Yapıcı bir hata oluştu. Lütfen geliştiriciye başvurun."}), 500


# --- ADMIN FONKSİYONLARI ---

# Admin girişi için statik bilgiler
ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')

# Yerel ve Render için HASH'lenmiş admin şifresi (Kullanıcının güvenli HASH'i buraya yerleştirildi)
DEFAULT_ADMIN_PASSWORD_HASH = 'pbkdf2:sha256:1000000$KetnleKDjZCas27g$da2281a11f74de96e3d30c9604adf8ea78067d9b80dc7fd19bb80b96e825cd04'

# Ortam değişkeni (Render) bu değişkeni ezmezse, koddaki HASH'i kullanır.
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', DEFAULT_ADMIN_PASSWORD_HASH)


def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.cookies.get('admin_token')
        if not token:
            return redirect(url_for('admin_login'))
        
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
            if data['username'] != ADMIN_USERNAME:
                 return redirect(url_for('admin_login'))

        except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
            return redirect(url_for('admin_login'))
            
        return f(*args, **kwargs)
    return decorated_function

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    """Admin Giriş Sayfası"""
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        if username == ADMIN_USERNAME and check_password_hash(ADMIN_PASSWORD_HASH, password):
            token_payload = {
                'username': ADMIN_USERNAME,
                'exp': datetime.utcnow() + timedelta(hours=1)
            }
            token = jwt.encode(token_payload, app.config['SECRET_KEY'], algorithm='HS256')
            
            response = redirect(url_for('admin_panel'))
            response.set_cookie('admin_token', token, max_age=3600, httponly=True) 
            return response
        else:
            error = 'Kullanıcı adı veya şifre hatalı!'
    
    # Basit bir giriş formu döndür
    return f"""
    <!DOCTYPE html>
    <html lang="tr">
    <head><title>Admin Girişi</title><style>
        body {{ font-family: sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; height: 100vh; }}
        .login-box {{ background: #161b22; padding: 40px; border-radius: 8px; border: 1px solid #30363d; }}
        input {{ padding: 10px; margin-bottom: 15px; width: 100%; box-sizing: border-box; background: #30363d; border: 1px solid #58a6ff; color: #e6edf3; }}
        button {{ padding: 10px 15px; background: #238636; color: white; border: none; border-radius: 6px; cursor: pointer; }}
        .error {{ color: #ff7b72; margin-bottom: 15px; }}
    </style></head>
    <body>
        <div class="login-box">
            <h2>Admin Girişi</h2>
            {f'<div class="error">{error}</div>' if error else ''}
            <form method="POST">
                <input type="text" name="username" placeholder="Kullanıcı Adı" required>
                <input type="password" name="password" placeholder="Şifre" required>
                <button type="submit">Giriş Yap</button>
            </form>
        </div>
    </body>
    </html>
    """

@app.route('/admin/panel')
@admin_required
def admin_panel():
    """Admin Ana Sayfası"""
    return render_template('admin.html')

@app.route('/api/admin/users')
@admin_required
def get_all_users():
    """Tüm kullanıcıları JSON formatında döndürür"""
    users = User.query.all()
    user_list = []
    for user in users:
        user_list.append({
            'id': user.id,
            'username': user.username,
            'email': user.email,
            'name': user.name,
            'surname': user.surname,
            'phone': user.phone,
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
    action = data.get('action')

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
            user.demo_chat_count = 5
            message = f"Kullanıcı '{username}' üyeliği DEMO durumuna çevrildi ve hakkı 5'e sıfırlandı."
        
        db.session.commit()
        return jsonify({'message': message, 'is_active': user.is_active_member})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': 'Veritabanı hatası: ' + str(e)}), 500

# --- Uygulama Başlatma ---
if __name__ == '__main__':
    # db.create_all() artık yukarıda çalıştırıldığı için bu kısım temizlendi.
    app.run(debug=True, host='0.0.0.0', port=10000)