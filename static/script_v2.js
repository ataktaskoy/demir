// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const messagesDiv = document.getElementById("messages");
const recordBtn = document.getElementById("recordBtn");

// --- Ses ve Durum Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 
let isBotProcessing = false; // Bot işlem yaparken UI'ı kilitlemek için
let finalTranscript = '';     // Sürekli dinleme için son metni tutar

// --- API Ayarları ---
const API_URL = "/ask"; 

// --- Mesajları Ekrana Ekleme ---
function appendMessage(text, sender) {
    const div = document.createElement("div");
    div.className = "message " + sender;
    div.innerText = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// YENİ: UI durumunu sıfırlayan ana fonksiyon
function resetUI() {
    isBotProcessing = false;
    setUIEnabled(true);
    // Geri bildirim rengini sıfırla
    userInput.style.backgroundColor = '#161b22'; 
    // Dinlemeyi yeniden başlatmayı garanti et
    // Timeout ekleyerek recognition.onend olayının tamamen bitmesini bekliyoruz.
    setTimeout(startListening, 500); 
}


// --- Sesli Okuma Fonksiyonu (TTS) ---
function playAudioFromBase64(base64Data) {
    // Eğer mevcut ses oynuyorsa, durdur
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    
    // Ses verisini oluştur ve oynat
    const audioUrl = `data:audio/mpeg;base64,${base64Data}`;
    currentAudio = new Audio(audioUrl);
    
    currentAudio.onplay = () => {
        isSpeaking = true;
    };
    
    currentAudio.onended = () => {
        isSpeaking = false;
        // HATA DÜZELTMESİ: Ses bittiğinde UI'ı sıfırla
        resetUI(); 
    };

    currentAudio.onerror = () => {
        isSpeaking = false;
        console.error("Ses oynatma hatası. Metin gösteriliyor.");
        // Hata durumunda UI'ı sıfırla
        resetUI();
    };

    // Ses hemen oynatılır
    currentAudio.play().catch(e => {
        console.error("Ses oynatma hatası (Auto-play engellendi?).", e);
        // Oynatma hatasında UI'ı sıfırla
        resetUI();
    });
}

// UI Butonlarını kilitleme/açma fonksiyonu
function setUIEnabled(enabled) {
    userInput.disabled = !enabled;
    // KRİTİK DÜZELTME: Artık otomatik gönderim yapacağımız için Gönder butonunu tamamen devre dışı bırakıyoruz.
    sendBtn.disabled = true; 
    
    if (enabled) {
        userInput.placeholder = "Dinliyorum...";
    } else {
        userInput.placeholder = "Bot cevaplıyor, lütfen bekleyin...";
    }
}


// --- API İsteği Gönderme ---
async function sendMessage(message) {
    // İşlem devam ediyorsa veya mesaj boşsa gönderme
    if (isBotProcessing || message.trim() === "") {
        // Eğer boş mesaj gelirse bile dinlemeyi resetle.
        if (message.trim() === "") resetUI(); 
        return;
    }
    
    // İşlem başladığında UI'ı kilitle ve dinlemeyi durdur
    isBotProcessing = true;
    setUIEnabled(false);
    stopListening(false); // Dinlemeyi durdur, UI rengini değiştirmesin

    
    appendMessage(message, "user");
    userInput.value = "";
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Hatası: ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        const botText = data.answer;
        
        appendMessage(botText, "bot");
        
        if (data.audio_base64) {
            // Sesli yanıtı oynat
            playAudioFromBase64(data.audio_base64);
        } else {
            // Ses yoksa, hemen UI'ı sıfırla
            resetUI();
        }

    } catch (error) {
        console.error('İstek hatası:', error);
        appendMessage(`Hata oluştu: ${error.message}`, "bot");
        // Hata durumunda UI'ı sıfırla
        resetUI();
    }
}

// --- Klavye ve Gönder Butonu Olayları ---
// Klavye olayları sadece acil durumda manuel kullanım için duruyor.
sendBtn.addEventListener('click', () => {
    sendMessage(userInput.value);
});

userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage(userInput.value);
    }
});


// ===============================================
// SÜREKLİ DİNLEME ve OTOMATİK GÖNDERİM MANTIĞI
// ===============================================

function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.error("Tarayıcınız Konuşma Tanımayı desteklemiyor.");
        recordBtn.style.display = 'none'; 
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'tr-TR';
    recognition.interimResults = true;  // Anlık (Real-Time) metin sonuçlarını etkinleştir!
    recognition.continuous = true;      // Sürekli dinleme
    // YENİ KRİTİK AYAR: Sessizlik süresini kısalt (Tarayıcıya bağlıdır, her zaman çalışmaz!)
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // recognition.serviceURI = 'https://www.google.com/speech-api/v2/recognize'; // Genelde buna gerek kalmaz.

    // --- Olay Dinleyicileri ---
    
    recognition.onresult = (event) => {
        let interimTranscript = '';
        finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                // Konuşma tanıma, cümlenin bittiğine karar verdi.
                finalTranscript += transcript;
            } else {
                // Henüz tamamlanmamış (interim) metin
                interimTranscript += transcript;
            }
        }
        
        // ANLIK GERİ BİLDİRİM: Metin girişi sırasında input alanına yazdır
        // YENİ DÜZELTME: Sadece interim metin gösterilir. Final metin gönderildiğinde input boşaltılır.
        userInput.value = interimTranscript; 
        
        // KRİTİK: Kullanıcı konuşmaya başladıysa ve bot konuşuyorsa, botu ANINDA kes.
        if (interimTranscript.length > 0 && isSpeaking && currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
            // Bot kesildiğinde, recognition.onend'in tetiklenmesini beklemeyiz.
            // Konuşma kesilince, metni toplama olayını kesiyoruz ve dinlemeyi durduruyoruz.
            // Ancak, kullanıcının konuşmasının bitmesini beklemeliyiz (onend).
        }
    };

    // Dinleme bittiğinde (sessizlik aralığı dolduğunda)
    recognition.onend = () => {
        // Otomasyonun anahtarı: Konuşma bittiyse (sessizlik olduysa) ve final metin varsa GÖNDER!
        if (finalTranscript.trim() !== '') {
            
            // Konuşma bitti ve metin hazır. UI'daki geçici metni temizle.
            userInput.value = ''; 
            
            // **OTOMATİK GÖNDERİM**: Mesajı yolla.
            sendMessage(finalTranscript);
            finalTranscript = ''; // Metni temizle
            
        } else {
            // Konuşma yoktu, sadece sessizlikti. Bot işlem yapmıyorsa, dinlemeye geri dön.
            if (!isBotProcessing) {
                 startListening(); 
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Konuşma Tanıma Hatası:', event.error);
        if (!isBotProcessing) {
             if (event.error !== 'not-allowed') {
                // Hata durumunda dinlemeyi tekrar başlat
                startListening(); 
             }
        }
    };
    
    // Mikrofon butonunu kaldırıyoruz, artık otomatik
    recordBtn.style.display = 'none'; 
    startListening();
}

function startListening() {
    if (!recognition || isBotProcessing) return;
    try {
        recognition.start();
        // GÖRSEL GERİ BİLDİRİM: Dinleme başladığında input arka planını yeşil yap
        userInput.style.backgroundColor = '#2c4a3d'; 
    } catch (e) {
        if (e.name !== 'InvalidStateError') {
             console.error("Dinleme başlatma hatası:", e);
        }
    }
}

// KRİTİK DÜZELTME: Rengi değiştirmemek için opsiyonel parametre
function stopListening(changeColor = true) {
    if (recognition) {
        recognition.stop();
        if (changeColor) {
            // GÖRSEL GERİ BİLDİRİM: Dinleme durduğunda arka planı normale döndür
            userInput.style.backgroundColor = '#161b22'; 
        }
    }
}


// --- Sayfa Yüklendiğinde ---
window.onload = () => {
    initRecognition();
    initThreeJS();
    // Gönder butonunu UI'dan kaldırmasak bile mantıksal olarak devre dışı bırakıyoruz.
    sendBtn.style.display = 'none'; 
};

// ===============================================
// THREE.JS GÖRSELLEŞTİRME KODU (DEĞİŞMEDİ)
// ===============================================
// ... (Bu kısım aynı kalır)

let scene, camera, renderer, sphere;
let frameCount = 0;

function initThreeJS() {
    const canvas = document.getElementById('bgCanvas');
    const width = window.innerWidth;
    const height = window.innerHeight;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.z = 5;

    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setSize(width, height);

    // Işık
    const light = new THREE.AmbientLight(0xffffff, 2);
    scene.add(light);
    
    const geometry = new THREE.IcosahedronGeometry(2, 2); 
    const material = new THREE.MeshPhongMaterial({
        color: 0x1e90ff, 
        wireframe: true, 
        transparent: true,
        opacity: 0.8
    });
    sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    animate();
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    let baseScale = 2; 
    let audioEffect = 0;

    if (isSpeaking) {
        frameCount += 0.2;
        audioEffect = (Math.random() * 0.1) + Math.sin(frameCount) * 0.15;
    } else {
        frameCount = 0;
    }

    // Dönme
    sphere.rotation.x += 0.005;
    sphere.rotation.y += 0.005;

    // Ses efekti ile ölçeklendirme
    sphere.scale.set(baseScale + audioEffect, baseScale + audioEffect, baseScale + audioEffect);

    renderer.render(scene, camera);
}