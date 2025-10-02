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
import jwt 
from datetime import datetime, timedelta # KRİTİK İMPORT: Admin girişi için gereklidir
from werkzeug.security import generate_password_hash, check_password_hash

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

# --- Flask-Login Kullanıcı Yöneticisi ---
@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# --- Veritabanı Modelleri ---
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    
    # Kayıtta Alınan Alanlar
    full_name = db.Column(db.String(150), nullable=True) 
    gender = db.Column(db.String(10), nullable=True)     
    dob = db.Column(db.String(10), nullable=True)        
    grade = db.Column(db.String(50), nullable=True)      
    
    is_active_member = db.Column(db.Boolean, default=False)
    demo_chat_count = db.Column(db.Integer, default=5)
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


# --- Rotalar ---

# Ana Sayfa Rotası (Sohbet Arayüzü)
@app.route('/')
@login_required
def index():
    return render_template('index.html')

# Statik dosyaları sunma
@app.route('/<path:filename>')
def serve_static_files(filename):
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
            return jsonify({'message': 'Giriş başarılı!'}), 200 
        else:
            return jsonify({'error': 'Kullanıcı adı veya şifre hatalı.'}), 401
    
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
        
        full_name = request.form.get('full_name', '').strip()
        gender = request.form.get('gender', '').strip()
        dob = request.form.get('dob', '').strip()
        grade = request.form.get('grade', '').strip()
        
        if not (username and email and password and full_name and gender and dob and grade):
            return jsonify({'error': 'Lütfen tüm zorunlu alanları doldurun.'}), 400

        if User.query.filter_by(username=username).first():
            return jsonify({'error': 'Bu kullanıcı adı zaten kullanılıyor.'}), 409

        if User.query.filter_by(email=email).first():
            return jsonify({'error': 'Bu e-posta adresi zaten kullanılıyor.'}), 409

        new_user = User(
            username=username,
            email=email,
            full_name=full_name,
            gender=gender,
            dob=dob,
            grade=grade,
            is_active_member=False,
            demo_chat_count=5
        )
        new_user.set_password(password)
        
        try:
            db.session.add(new_user)
            db.session.commit()
            return jsonify({'message': 'Kayıt başarılı! Şimdi giriş yapabilirsiniz.'}), 200
        except Exception as e:
            db.session.rollback()
            logging.error(f"Kayıt hatası: {str(e)}")
            return jsonify({'error': 'Veritabanına kaydederken bir hata oluştu.'}), 500

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
            'full_name': current_user.full_name or '',
            'gender': current_user.gender or '',
            'dob': current_user.dob or '',
            'is_active_member': current_user.is_active_member,
            'demo_chat_count': current_user.demo_chat_count,
            'grade': current_user.grade or ''
        })

    elif request.method == 'POST':
        # Sadece sınıf güncelleme varsayımı
        grade = request.form.get('grade')
        
        current_user.grade = grade
        
        try:
            db.session.commit()
            return jsonify({'message': 'Sınıf bilgisi başarıyla güncellendi.'}), 200
        except Exception as e:
            db.session.rollback()
            logging.error(f"Profil güncelleme hatası: {str(e)}")
            return jsonify({'error': 'Profil güncellenirken bir hata oluştu.'}), 500

# Sohbet API Rotası
@app.route('/ask', methods=['POST'])
@login_required
def ask():
    # 1. Demo Hakkı Kontrolü
    if not current_user.is_active_member and current_user.demo_chat_count <= 0:
        return jsonify({
            "answer": "Demo hakkınız dolmuştur. Tüm özelliklere erişmek için lütfen tam üyeliğe geçin.", 
            "error": "Demo hakkı bitti"
        }), 402

    # 2. Mesaj İşleme
    data = request.get_json()
    user_message = data.get("message", "").strip()

    if not user_message:
        return jsonify({"error": "Mesaj boş olamaz."}), 400
        
    # AI Bağlamı: Kullanıcının tüm bilgilerini birleştir
    user_context = (
        f"Kullanıcının Adı: {current_user.full_name or 'Belirtilmemiş'}. "
        f"Cinsiyeti: {current_user.gender or 'Belirtilmemiş'}. "
        f"Doğum Tarihi: {current_user.dob or 'Belirtilmemiş'}. "
        f"Kullanıcının sınıfı/seviyesi: {current_user.grade or 'Belirtilmemiş'}."
    )

    client = openai.OpenAI(
        api_key=OPENROUTER_API_KEY,
        base_url="https://openrouter.ai/api/v1",
    )

    try:
        logging.info(f"OpenAI API'ye istek gönderiliyor (Kullanıcı: {current_user.username})...")
        
        response = client.chat.completions.create(
            model="openai/gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": f"Sen AI öğretmenisin. Soruları yaşına ve sınıfına uygun, arkadaş canlısı ve eğitici bir dille yanıtla. Kullanıcı bağlamı: {user_context}"},
                {"role": "user", "content": user_message}
            ],
        )

        answer = response.choices[0].message.content
        
        # 3. Demo Hakkını Güncelleme (Sadece demo üyeler için)
        if not current_user.is_active_member:
            current_user.demo_chat_count -= 1
        
        # 4. Veritabanına kaydet
        new_answer = Chat(user_id=current_user.id, message=user_message, response=answer)
        db.session.add(new_answer)
        db.session.commit()

        # 5. Ses Üretimi (Edge TTS)
        audio_base64 = ""
        
        try:
            logging.info("Edge TTS ile ses üretiliyor (Hız: +3%)...")
            
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+3%"
            
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

        return jsonify({"answer": answer, "audio_base64": audio_base64}), 200

    except Exception as e:
        db.session.rollback()
        logging.error(f"Genel API HATA: {str(e)}")
        return jsonify({"error": "Yapıcı bir hata oluştu. Lütfen geliştiriciye başvurun."}), 500


# --- ADMIN PANELİ FONKSİYONLARI ---

# Admin girişi için statik bilgiler
ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')

# KRİTİK HASH: Şifre: TempSecure123! - Bu hash'i sistemde ürettim.
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', 'pbkdf2:sha256:1000000$qkrj5DP2DFlvow2A$b454d092095f969fcb7f7eb50d519ac18f26e77add82417b1cb23d83ca92d78a')

@app.route('/admin', methods=['GET', 'POST'])
def admin_login():
    """Admin Giriş Sayfası"""
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        # Admin şifresini kontrol et
        if username == ADMIN_USERNAME and check_password_hash(ADMIN_PASSWORD_HASH, password):
            
            # Giriş başarılıysa token oluştur
            token_payload = {
                'username': ADMIN_USERNAME,
                'exp': datetime.utcnow() + timedelta(hours=1)
            }
            token = jwt.encode(token_payload, app.config['SECRET_KEY'], algorithm='HS256')
            
            response = redirect(url_for('admin_panel'))
            response.set_cookie('admin_token', token, max_age=3600, httponly=True) 
            return response
        else:
            # Şifre yanlışsa bu hatayı ayarla
            error = 'Kullanıcı adı veya şifre hatalı!'
            
    # Eğer POST değilse (GET) veya POST başarısızsa, login.html'i render et
    return render_template('login.html', admin_mode=True, error=error)

def admin_required(f):
    """Admin yetkisi kontrolü için dekoratör"""
    from functools import wraps
    
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.cookies.get('admin_token')
        if not token:
            return redirect(url_for('admin_login'))
        
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
            if data['username'] != ADMIN_USERNAME:
                 return redirect(url_for('admin_login'))

        except jwt.ExpiredSignatureError:
            return redirect(url_for('admin_login'))
        except jwt.InvalidTokenError:
            return redirect(url_for('admin_login'))
            
        return f(*args, **kwargs)
    return decorated_function

@app.route('/admin/panel')
@admin_required
def admin_panel():
    """Admin Ana Sayfası (Kullanıcı Listesi)"""
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
            'full_name': user.full_name, 
            'gender': user.gender,       
            'dob': user.dob,             
            'grade': user.grade,         
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
    with app.app_context():
        db.create_all() 
    
    app.run(debug=True, host='0.0.0.0', port=10000)