from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import openai
import base64
import io
import logging
from gtts import gTTS
# Edge TTS için gerekli kütüphaneler
import subprocess
import tempfile
import os 
import time

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

# Logging ayarları
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')

# API Key'leriniz
# NOT: Render üzerinde bu anahtar Environment Variables (Ortam Değişkenleri) ile tanımlanacaktır.
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "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")

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
    logging.debug(f"Gelen soru: {question}")
    
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

        # 2. Ses Üretimi (Edge TTS - HIZ AYARI EKLENDİ)
        audio_base64 = ""
        
        try:
            VOICE = "tr-TR-EmelNeural" 
            RATE = "+18%" 
            
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
            # Yedek: gTTS
            tts = gTTS(text=answer, lang='tr', slow=False)
            audio_buffer = io.BytesIO()
            tts.write_to_fp(audio_buffer)
            audio_buffer.seek(0)
            audio_base64 = base64.b64encode(audio_buffer.read()).decode('utf-8')


        return jsonify({"answer": answer, "audio_base64": audio_base64})

    except Exception as e:
        logging.error(f"Genel hata oluştu: {str(e)}", exc_info=True)
        return jsonify({"error": "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin."}), 500

if __name__ == "__main__":
    app.run(debug=True)