# Temel Python imajını kullan
FROM python:3.11-slim

# FFmpeg kurulumu için gerekli komutlar
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Çalışma dizinini ayarla
WORKDIR /usr/src/app

# Python bağımlılıklarını kopyala ve kur
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Uygulama dosyalarını kopyala
COPY . .

# Uygulamanın çalışacağı portu belirle
EXPOSE 10000

# Uygulamayı başlat (gunicorn kullanarak)
CMD ["gunicorn", "--worker-class", "gevent", "-b", "0.0.0.0:10000", "server:app"]