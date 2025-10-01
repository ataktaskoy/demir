// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const messagesDiv = document.getElementById("messages");
const ttsToggleBtn = document.getElementById("ttsToggleBtn"); 
const micToggleBtn = document.getElementById("micToggleBtn"); 

// --- Ses ve Durum Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 
let isBotProcessing = false; 
let finalTranscript = '';     // Kesinleşmiş (Final) metinleri tutar
let interimTranscript = '';   // YENİ: Kesinleşmemiş (Interim) metinleri tutar
let ttsEnabled = true;        
let micEnabled = true;        
let recognitionActive = false;
let silenceTimeout = null;    

// --- AYARLAR ---
const API_URL = "/ask"; 
const SILENCE_THRESHOLD_MS = 1500; // 1.5 saniye sessizlik sonrası otomatik gönder

// --- Mesajları Ekrana Ekleme ---
function appendMessage(text, sender) {
    const div = document.createElement("div");
    div.className = "message " + sender;
    div.innerText = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// UI durumunu sıfırlayan ana fonksiyon
function resetUI() {
    isBotProcessing = false;
    setUIEnabled(true);
    userInput.style.backgroundColor = '#161b22'; 
    if (micEnabled) { 
        setTimeout(startListening, 500); 
    }
}


// --- Sesli Okuma Fonksiyonu (TTS) ---
function playAudioFromBase64(base64Data) {
    if (!ttsEnabled) {
        resetUI();
        return;
    }
    
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    
    const audioUrl = `data:audio/mpeg;base64,${base64Data}`;
    currentAudio = new Audio(audioUrl);
    
    currentAudio.onplay = () => {
        isSpeaking = true;
    };
    
    currentAudio.onended = () => {
        isSpeaking = false;
        resetUI(); 
    };

    currentAudio.onerror = () => {
        isSpeaking = false;
        console.error("Ses oynatma hatası.");
        resetUI();
    };

    currentAudio.play().catch(e => {
        console.error("Ses oynatma hatası (Auto-play engellendi?).", e);
        resetUI();
    });
}

// UI Butonlarını kilitleme/açma fonksiyonu
function setUIEnabled(enabled) {
    userInput.disabled = !enabled;
    
    if (enabled) {
        userInput.placeholder = "Dinliyorum...";
    } else {
        userInput.placeholder = "Bot cevaplıyor, lütfen bekleyin...";
    }
}


// --- API İsteği Gönderme ---
async function sendMessage(message) {
    if (silenceTimeout) {
        clearTimeout(silenceTimeout);
        silenceTimeout = null;
    }
    
    if (isBotProcessing || message.trim() === "") {
        if (message.trim() === "") resetUI(); 
        return;
    }
    
    isBotProcessing = true;
    setUIEnabled(false);
    stopListening(false); 

    
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
        
        if (data.audio_base64 && ttsEnabled) {
            playAudioFromBase64(data.audio_base64);
        } else {
            resetUI();
        }

    } catch (error) {
        console.error('İstek hatası:', error);
        appendMessage(`Hata oluştu: ${error.message}`, "bot");
        resetUI();
    }
}

// --- Kontrol Butonu Olayları ---

// TTS Aç/Kapat
ttsToggleBtn.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    ttsToggleBtn.innerHTML = ttsEnabled ? '<i class="fas fa-volume-up"></i>' : '<i class="fas fa-volume-mute"></i>';
    ttsToggleBtn.classList.toggle('active', ttsEnabled); 
    
    if (!ttsEnabled && isSpeaking && currentAudio) {
        currentAudio.pause();
        currentAudio = null;
        isSpeaking = false;
        resetUI(); 
    }
});

// Mikrofon Aç/Kapat
micToggleBtn.addEventListener('click', () => {
    micEnabled = !micEnabled;
    micToggleBtn.innerHTML = micEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
    micToggleBtn.classList.toggle('active', micEnabled);

    if (micEnabled) {
        startListening();
    } else {
        stopListening();
    }
});


// ===============================================
// SÜREKLİ DİNLEME ve OTOMATİK GÖNDERİM MANTIĞI
// ===============================================

function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.error("Tarayıcınız Konuşma Tanımayı desteklemiyor.");
        micToggleBtn.style.display = 'none'; 
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'tr-TR';
    recognition.interimResults = true;  
    recognition.continuous = true;      

    // --- Olay Dinleyicileri ---
    
    recognition.onstart = () => { 
        recognitionActive = true;
        userInput.style.backgroundColor = '#2c4a3d'; // Yeşil renk
    };

    recognition.onresult = (event) => {
        // Yeni dinleme döngüsünde metinleri sıfırla
        let newInterimTranscript = '';
        let newFinalTranscript = '';
        
        // KRİTİK: Sessizlik zamanlayıcısını her yeni ses geldiğinde sıfırla
        if (silenceTimeout) {
            clearTimeout(silenceTimeout);
        }
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                newFinalTranscript += transcript;
            } else {
                newInterimTranscript += transcript;
            }
        }
        
        // Global değişkenleri güncelle
        finalTranscript += newFinalTranscript; // Kesinleşmiş metni biriktir
        interimTranscript = newInterimTranscript; // Anlık metni göster

        // ANLIK GERİ BİLDİRİM: Konuşuldukça metni göster (birikmiş final + anlık interim)
        // Düzeltme: Sadece anlık metni göstermek daha doğru ve stabil
        userInput.value = interimTranscript; 
        
        // KRİTİK: Konuşma metni varsa, otomatik durdurma zamanlayıcısını başlat
        // Kontrol: Eğer konuşma tanıma bir metin üretiyorsa (interim veya final)
        if (interimTranscript.length > 0 || newFinalTranscript.length > 0) {
            silenceTimeout = setTimeout(() => {
                // Sessizlik eşiği aşıldı, otomatik olarak dinlemeyi durdur
                stopListening(); 
            }, SILENCE_THRESHOLD_MS);
        }

        // BOTU KESME MANTIĞI
        if ((interimTranscript.length > 0 || newFinalTranscript.length > 0) && isSpeaking && currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
            stopListening(); // Bot kesildiğinde hemen durdur, zamanlayıcı gönderecek
        }
    };

    recognition.onend = () => { 
        recognitionActive = false;
        userInput.style.backgroundColor = '#161b22'; 
        
        if (silenceTimeout) {
            clearTimeout(silenceTimeout);
            silenceTimeout = null;
        }
        
        // KRİTİK DÜZELTME: GÖNDERİLECEK METİN
        // Final metin (kesinleşmiş) VEYA interim (o an inputta kalan metin) varsa GÖNDER.
        const textToSend = (finalTranscript.trim() + " " + userInput.value.trim()).trim();
        
        // Gönderim yapıldıktan sonra tüm metinleri sıfırla
        finalTranscript = ''; 
        interimTranscript = '';
        
        if (textToSend) {
            userInput.value = ''; 
            sendMessage(textToSend);
            
        } else {
            if (!isBotProcessing && micEnabled) {
                 startListening(); 
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Konuşma Tanıma Hatası:', event.error);
        recognitionActive = false; 
        userInput.style.backgroundColor = '#161b22'; 
        
        if (!isBotProcessing && micEnabled) {
             if (event.error !== 'not-allowed') { 
                startListening(); 
             } else {
                 console.error("Mikrofon izni reddedildi.");
                 micEnabled = false; 
                 micToggleBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                 micToggleBtn.classList.remove('active');
                 userInput.placeholder = "Mikrofon izni gerekli.";
             }
        }
    };
    
    if (micEnabled) {
        startListening();
    }
}

// Dinlemeyi başlatan fonksiyon
function startListening() {
    if (!recognition || isBotProcessing || recognitionActive || !micEnabled) return;
    try {
        recognition.start();
    } catch (e) {
        if (e.name !== 'InvalidStateError') {
             console.error("Dinleme başlatma hatası:", e);
        }
    }
}

// Dinlemeyi durduran fonksiyon
function stopListening(changeColor = true) {
    if (recognition && recognitionActive) { 
        recognition.stop();
    }
}


// --- Sayfa Yüklendiğinde ---
window.onload = () => {
    initRecognition();
    initThreeJS();
    
    // Butonların başlangıç durumlarını ayarla
    ttsToggleBtn.classList.add('active'); 
    micToggleBtn.classList.add('active'); 
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

    sphere.rotation.x += 0.005;
    sphere.rotation.y += 0.005;

    sphere.scale.set(baseScale + audioEffect, baseScale + audioEffect, baseScale + audioEffect);

    renderer.render(scene, camera);
}