from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import openai
import base64
import io
import logging
import os # Ortam değişkenleri ve subprocess için
import subprocess # Edge-TTS için
import tempfile
import time 

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Logging ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# API Anahtarı: Ortam değişkenlerinden güvenli bir şekilde alınır
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")

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
    
    # API Anahtarını kontrol et
    if not OPENROUTER_API_KEY:
        return jsonify({"error": "Sunucu API anahtarı eksik. Render ayarlarınızı kontrol edin."}), 500

    # ÖDEV ÖĞRETMENİ SİSTEM TALİMATI
    system_prompt = (
        "Sen, 12 yaşındaki Demir'in **özel, çok neşeli ve sohbet etmeyi seven** bir yapay zeka öğretmenisin. "
        "Rolün, Demir'in tüm ödevlerinde ve derslerinde ona yardımcı olmak, ancak **ASLA DOĞRUDAN CEVABI VERMEMEK**. "
        "Cevap verme felsefen şunlara dayanır: "
        "1. **Muhabbet Tonu:** Yanıtların son derece samimi ve neşeli olsun. Sanki Demir'in en sevdiği ablası/abisi gibi konuş. "
        "2. **Teşvik ve Neşe:** Cevaba her zaman coşkulu bir giriş veya motive edici bir ifadeyle başla. (Örn: 'Vay canına, bu çok heyecan verici bir soru! Hadi birlikte bakalım.') "
        "3. **Sokratik Yöntem:** Cevap vermek yerine, Demir'e **bir sonraki adımı bulması için yönlendirici, temel bir kuralı hatırlatan veya konuyu çağrıştıran BİR SORU** sor. "
        "4. **Zorlama ve İlerleme:** İpuçları küçük olmalı ve 'Haydi, şimdi bu ipucuyla tekrar dene!' veya 'Buna eminim sen de ulaşırsın!' gibi zorlayıcı/teşvik edici ifadelerle bitmeli. "
        "5. **Ses Uyumu (Çok Önemli):** Metinlerinde **ASLA emoji veya özel karakter kullanma**. Sadece doğal duraklamalar ve akıcı bir ses tonu için virgül (,) ve nokta (.) kullan. Yanıtların kısa ve seslendirmeye uygun olsun."
    )

    try:
        # 1. Metin Cevabını Alma (OpenRouter - Claude 3.5 Sonnet)
        client_openai = openai.OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
        completion = client_openai.chat.completions.create(
            model="anthropic/claude-3-5-sonnet", 
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": question}
            ]
        )
        answer = completion.choices[0].message.content

        # 2. Ses Üretimi (Edge TTS - HIZ AYARI DÜZELTİLDİ)
        audio_base64 = ""
        
        try:
            logging.info("Edge TTS ile ses üretiliyor (Hız: +5%)...")
            
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+5%" # Stabil hız ayarı
            
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
        return jsonify({"error": "Sunucuya ulaşılamıyor. Lütfen Render Kayıtlarını kontrol edin."}), 500

if __name__ == "__main__":
    app.run(debug=True)