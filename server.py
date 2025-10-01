from flask import Flask, request, jsonify, send_from_directory, session # 'session' eklendi
from flask_cors import CORS
import openai
import base64
import io
import logging
import os 
import subprocess 
import tempfile
import time 

# --- FLASK AYARLARI ---
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Session verisini güvenli hale getirmek için SECRET_KEY eklenmeli.
# Render'da Ortam Değişkeni olarak ekleyeceğiz.
# Ortam değişkeni yoksa geçici bir anahtar kullanır.
app.config['SECRET_KEY'] = os.environ.get("SECRET_KEY", "flask_guvenli_gizli_anahtar_degistirilmeli")

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- AI MODEL AYARLARI ---
# Hız ve düşük maliyet için Claude 3 Haiku'ya geçiş (OpenRouter üzerinden)
MODEL_NAME = "anthropic/claude-3-haiku" 

# API Anahtarı: Ortam değişkenlerinden güvenli bir şekilde alınır
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

# --- ROUTELAR (Yollar) ---

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/favicon.ico")
def favicon():
    return send_from_directory("static", "favicon.ico")

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json()
    question = data.get("message", "")
    logging.info(f"Gelen soru: {question}")
    
    # 1. OTURUM HAFIZASI YÜKLEME VEYA BAŞLATMA
    # Session'da mesaj geçmişi yoksa, varsayılan (system prompt) ile başlat.
    if 'messages' not in session:
        # **Sistem Talimatı (Prompt)**: Yaş, derse odaklama ve 'Aa' filtresi burada.
        # Yaş hesaplamasını modelin yapması için BUGÜNÜN TARİHİ eklenir.
        system_prompt = f"""
        Sen 17.11.2013 doğumlu, ilkokul 4. sınıf öğrencisi Demir'e derslerinde yardımcı olan bir yapay zeka öğretmenisin.
        BUGÜNÜN TARİHİ: {time.strftime('%Y-%m-%d')}
        Lütfen Demir'i sık sık derslere ve ödevlerine odaklamaya çalış (ancak sürekli aynı şeyi tekrarlama). Cevapların kısa, net, motive edici ve akıcı olsun.
        'Aa' veya 'Vaay' gibi sesli algılama hatalarını görmezden gel, sadece anlamlı cümlelere odaklan.
        """
        session['messages'] = [{"role": "system", "content": system_prompt.strip()}]
    
    # Kullanıcının yeni mesajını hafızaya ekle
    session['messages'].append({"role": "user", "content": question})

    # API Anahtarını kontrol et
    if not OPENROUTER_API_KEY:
        logging.error("Sunucu API anahtarı eksik.")
        return jsonify({"error": "Sunucu API anahtarı eksik. Render ayarlarınızı kontrol edin."}), 500

    try:
        # OpenAI Client'ı OpenRouter ile kullan
        client_openai = openai.OpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
        )

        # API çağrısı için artık tüm hafızadaki mesajları (session['messages']) gönder
        completion = client_openai.chat.completions.create(
            model=MODEL_NAME,
            messages=session['messages'], # BURASI HAFIZA İÇİN KRİTİK DEĞİŞİKLİK
            stream=False, 
        )
        
        answer = completion.choices[0].message.content
        
        # BOT CEVABINI HAFIZAYA EKLE (Sonraki sorular için)
        session['messages'].append({"role": "assistant", "content": answer})

        audio_base64 = "" # Eğer TTS başarısız olursa boş dönecek
        
        try:
            # TTS AYARLARI
            VOICE = "tr-TR-EmelNeural"
            RATE = "+18%" 
            
            # Geçici dosya oluşturma
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp_audio:
                temp_filename = tmp_audio.name
            
            # Edge TTS komutunu çalıştır (subprocess)
            command = [
                'edge-tts',
                '--text', answer,
                '--voice', VOICE,
                '--rate', RATE,
                '--write-media', temp_filename
            ]
            
            # Subprocess ile komutu çalıştır. Docker'da FFmpeg olduğu için çalışır.
            subprocess.run(command, check=True, capture_output=True)
            
            # Ses verisini oku ve base64'e çevir
            with open(temp_filename, 'rb') as f:
                audio_data = f.read()
            
            # Geçici dosyayı sil
            os.remove(temp_filename)

            audio_base64 = base64.b64encode(audio_data).decode('utf-8')

        except Exception as tts_error:
            # EDGE-TTS'de HATA OLURSA BİLE BOT ÇÖKMESİN DİYE BOŞ GÖNDERİYORUZ
            logging.error(f"Edge TTS HATA: Ses üretilemedi. Metin cevabı gönderiliyor. Hata: {str(tts_error)}", exc_info=True)
            pass 

        return jsonify({"answer": answer, "audio_base64": audio_base64})

    except Exception as e:
        logging.error(f"Genel hata oluştu: {str(e)}", exc_info=True)
        # Hata kodu 401 ise API Anahtarı hatası olduğunu anımsat.
        if "401" in str(e):
             return jsonify({"error": "API Anahtarı (OpenRouter) hatası: Lütfen Render Ortam Değişkenini kontrol edin."}), 500
        return jsonify({"error": "İstek işlenirken bir sorun oluştu."}), 500