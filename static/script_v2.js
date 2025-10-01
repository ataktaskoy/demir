// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const messagesDiv = document.getElementById("messages");
const ttsToggleBtn = document.getElementById("ttsToggleBtn"); 
const micToggleBtn = document.getElementById("micToggleBtn"); 

// --- Ses ve Durum Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 
let isBotProcessing = false; // Bot işlem yaparken UI'ı kilitlemek için
let finalTranscript = '';     // Sürekli dinleme için son metni tutar
let ttsEnabled = true;        // TTS varsayılan olarak açık
let micEnabled = true;        // YENİ: Mikrofon varsayılan olarak açık
let recognitionActive = false; // YENİ: Konuşma tanıma aktif mi?

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

// UI durumunu sıfırlayan ana fonksiyon
function resetUI() {
    isBotProcessing = false;
    setUIEnabled(true);
    userInput.style.backgroundColor = '#161b22'; // Geri bildirim rengini sıfırla
    // Sadece mikrofon açıksa dinlemeyi başlat
    if (micEnabled) { 
        setTimeout(startListening, 500); 
    }
}


// --- Sesli Okuma Fonksiyonu (TTS) ---
function playAudioFromBase64(base64Data) {
    // Eğer TTS kapalıysa, sadece metin gösterip hemen resetle
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
    // MicToggleBtn sadece dinleme aktifse veya devre dışı bırakılırsa etkilenir.
    // ttsToggleBtn her zaman aktif kalır.
    
    if (enabled) {
        userInput.placeholder = "Dinliyorum...";
    } else {
        userInput.placeholder = "Bot cevaplıyor, lütfen bekleyin...";
    }
}


// --- API İsteği Gönderme ---
async function sendMessage(message) {
    if (isBotProcessing || message.trim() === "") {
        if (message.trim() === "") resetUI(); 
        return;
    }
    
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
        // Bot konuşurken sesi kapatırsak, botu hemen kesip dinlemeyi başlat
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
        micToggleBtn.style.display = 'none'; // Butonu gizle
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'tr-TR';
    recognition.interimResults = true;  
    recognition.continuous = true;      

    // --- Olay Dinleyicileri ---
    
    recognition.onstart = () => { // YENİ: Dinleme başladığında aktif olarak işaretle
        recognitionActive = true;
        userInput.style.backgroundColor = '#2c4a3d'; // Yeşil renk
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let currentFinalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                currentFinalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        
        // finalTranscript'i onend için güncelle
        finalTranscript = currentFinalTranscript;
        
        // ANLIK GERİ BİLDİRİM: Konuşuldukça metni göster
        userInput.value = interimTranscript; 
        
        // KRİTİK: Kullanıcı konuşmaya başladıysa ve bot konuşuyorsa, botu ANINDA kes.
        if (interimTranscript.length > 0 && isSpeaking && currentAudio) {
            currentAudio.pause();
            currentAudio = null;
            isSpeaking = false;
            // Bot kesildiğinde dinlemeyi durdur. onend olayı mesajı gönderecek.
            // Bu, döngüyü bozmaz, sadece bir konuşma döngüsünü tamamlar.
            stopListening();
        }
    };

    recognition.onend = () => { // YENİ: Dinleme bittiğinde pasif olarak işaretle
        recognitionActive = false;
        userInput.style.backgroundColor = '#161b22'; // Normal renk
        
        const textToSend = finalTranscript.trim() || userInput.value.trim();
        
        if (textToSend) {
            userInput.value = ''; 
            sendMessage(textToSend);
            finalTranscript = ''; 
            
        } else {
            // Konuşma yoktu, sadece sessizlikti. Bot işlem yapmıyorsa ve mikrofon açıksa, dinlemeye geri dön.
            if (!isBotProcessing && micEnabled) {
                 startListening(); 
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Konuşma Tanıma Hatası:', event.error);
        recognitionActive = false; // Hata durumunda da pasif olarak işaretle
        userInput.style.backgroundColor = '#161b22'; // Normal renk
        if (!isBotProcessing && micEnabled) {
             if (event.error !== 'not-allowed') { // İzin reddi hariç tekrar başlat
                startListening(); 
             } else {
                 console.error("Mikrofon izni reddedildi. Lütfen tarayıcı ayarlarından izni verin.");
                 micEnabled = false; // Mikrofonu kapat
                 micToggleBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                 micToggleBtn.classList.remove('active');
                 userInput.placeholder = "Mikrofon izni gerekli.";
             }
        }
    };
    
    // Başlangıçta mikrofon açıksa dinlemeyi başlat
    if (micEnabled) {
        startListening();
    }
}

// YENİ: Dinlemeyi başlatan fonksiyon
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

// YENİ: Dinlemeyi durduran fonksiyon
function stopListening(changeColor = true) {
    if (recognition && recognitionActive) { // Sadece aktifse durdur
        recognition.stop();
        // onend olayının tetiklenmesini bekleriz, renk değişimi orada yapılır.
    }
}


// --- Sayfa Yüklendiğinde ---
window.onload = () => {
    initRecognition();
    initThreeJS();
    
    // TTS butonu varsayılan durumu ayarla
    ttsToggleBtn.classList.add('active'); // CSS'te başlangıçta aktif olduğunu göster.
    
    // Mic butonu varsayılan durumu ayarla
    micToggleBtn.classList.add('active'); // CSS'te başlangıçta aktif olduğunu göster.
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