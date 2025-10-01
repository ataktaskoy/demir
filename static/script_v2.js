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
        isBotProcessing = false; // İşlem bitti
        startListening(); 
        setUIEnabled(true);
    };

    currentAudio.onerror = () => {
        isSpeaking = false;
        console.error("Ses oynatma hatası.");
        isBotProcessing = false;
        startListening();
        setUIEnabled(true);
    };

    // Ses hemen oynatılır
    currentAudio.play().catch(e => console.error("Ses oynatma hatası:", e));
}

// UI Butonlarını kilitleme/açma fonksiyonu
function setUIEnabled(enabled) {
    userInput.disabled = !enabled;
    sendBtn.disabled = !enabled;
    
    if (enabled) {
        userInput.placeholder = "Sorunu yaz...";
    } else {
        userInput.placeholder = "Bot cevaplıyor, lütfen bekleyin...";
    }
}


// --- API İsteği Gönderme ---
async function sendMessage(message) {
    // İşlem devam ediyorsa veya mesaj boşsa gönderme
    if (isBotProcessing || message.trim() === "") return;
    
    // İşlem başladığında UI'ı kilitle
    isBotProcessing = true;
    setUIEnabled(false);
    
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
            // Ses yoksa, hemen dinlemeye başla
            isBotProcessing = false;
            startListening();
            setUIEnabled(true);
        }

    } catch (error) {
        console.error('İstek hatası:', error);
        appendMessage(`Hata oluştu: ${error.message}`, "bot");
        isBotProcessing = false;
        setUIEnabled(true);
        startListening();
    }
}

// --- Klavye ve Gönder Butonu Olayları ---
sendBtn.addEventListener('click', () => {
    sendMessage(userInput.value);
});

userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage(userInput.value);
    }
});


// ===============================================
// SÜREKLİ DİNLEME ve ANLIK METİN ÇEVİRİ MANTIĞI
// ===============================================

function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.error("Tarayıcınız Konuşma Tanımayı desteklemiyor.");
        recordBtn.style.display = 'none'; // Butonu gizle
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'tr-TR';
    recognition.interimResults = true;  // KRİTİK: Anlık (Real-Time) metin sonuçlarını etkinleştir!
    recognition.continuous = true;      // Sürekli dinleme

    // --- Olay Dinleyicileri ---
    
    recognition.onresult = (event) => {
        let interimTranscript = '';
        finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        
        // ANLIK GERİ BİLDİRİM: Metin girişi sırasında input alanına yazdır
        userInput.value = interimTranscript; 
        
        // Konuşma algılandıysa ve bot konuşuyorsa, botu kes
        if (interimTranscript.length > 0 && isSpeaking && currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
            stopListening();
        }
    };

    // Dinleme bittiğinde (sessizlik aralığı dolduğunda)
    recognition.onend = () => {
        // Tamamlanmış (Final) bir metin varsa, sunucuya gönder
        if (finalTranscript.trim() !== '') {
            
            // Eğer bot işlem yapıyorsa (mesela TTS'i kesmeden önce dinleme durmuşsa)
            if (isBotProcessing) {
                 setTimeout(() => {
                    sendMessage(finalTranscript);
                    finalTranscript = ''; // Metni temizle
                 }, 100);
            } else {
                // Bot boşta ise direkt gönder
                sendMessage(finalTranscript);
                finalTranscript = ''; // Metni temizle
            }
        } else {
            // Konuşma yoksa, hemen tekrar dinlemeye başla (sürekli dinleme)
            if (!isBotProcessing) {
                 setTimeout(startListening, 500); // Yarım saniye bekleyip tekrar başla
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Konuşma Tanıma Hatası:', event.error);
        if (!isBotProcessing) {
             // Hata durumunda (izin reddi hariç) tekrar başlat
             if (event.error !== 'not-allowed') {
                setTimeout(startListening, 1000); 
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
        // Bazen zaten dinlemede olduğu için hata verebilir, yoksay
        if (e.name !== 'InvalidStateError') {
             console.error("Dinleme başlatma hatası:", e);
        }
    }
}

function stopListening() {
    if (recognition) {
        recognition.stop();
        // GÖRSEL GERİ BİLDİRİM: Dinleme durduğunda arka planı normale döndür
        userInput.style.backgroundColor = '#161b22'; 
    }
}


// --- Sayfa Yüklendiğinde ---
window.onload = () => {
    initRecognition();
    initThreeJS();
};

// ===============================================
// THREE.JS GÖRSELLEŞTİRME KODU (DEĞİŞMEDİ)
// ===============================================

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