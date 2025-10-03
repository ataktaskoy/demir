// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const messagesDiv = document.getElementById("messages");
const ttsToggleBtn = document.getElementById("ttsToggleBtn"); 
const micToggleBtn = document.getElementById("micToggleBtn"); 
const sendBtn = document.getElementById("sendBtn");
const micStatusDiv = document.getElementById('micStatus'); 

// --- Ses ve Durum Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 
let isBotProcessing = false; 
let finalTranscript = '';     
let interimTranscript = '';   
let ttsEnabled = true;        
let micEnabled = true;        
let recognitionActive = false;
let silenceTimeout = null;    

// --- AYARLAR ---
const API_URL = "/ask"; 
const SILENCE_THRESHOLD_MS = 1500; // 1.5 saniye sessizlik sonrası otomatik gönder

// --- Kullanıcı Durumunu Yükleme ---
async function updateStatusDisplay() {
    try {
        const response = await fetch('/api/profile');
        if (response.ok) {
            const data = await response.json();
            const statusDiv = document.getElementById('memberStatus');
            
            if (data.is_active_member) {
                statusDiv.innerHTML = 'Aktif Üye <i class="fas fa-check-circle" style="color: #238636;"></i>';
            } else {
                statusDiv.innerHTML = `Demo Hakkınız: <strong>${data.demo_chat_count}</strong> kalan mesaj <i class="fas fa-comment"></i>`;
                
                if (data.demo_chat_count <= 0) {
                     statusDiv.innerHTML = 'Demo Hakkı Bitti! <i class="fas fa-exclamation-triangle" style="color: #ff7b72;"></i>';
                }
            }
        }
    } catch (error) {
        console.error('Durum yüklenirken hata:', error);
    }
}

// --- Mesaj Yönetimi ---
function appendMessage(text, sender) {
    const div = document.createElement("div");
    div.className = "message " + sender;
    div.innerText = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function resetUI() {
    isBotProcessing = false;
    setUIEnabled(true);
    if (recognitionActive) {
        micStatusDiv.textContent = 'Dinleniyor...';
        micStatusDiv.classList.remove('mic-status-hidden');
    }
}

function setUIEnabled(enabled) {
    userInput.disabled = !enabled;
    micToggleBtn.disabled = !enabled;
    sendBtn.disabled = !enabled;
    ttsToggleBtn.disabled = !enabled;
}

// Ses dosyasını oynatır (GERİ BESLEME DÖNGÜSÜ DÜZELTİLDİ)
function playAudio(base64Data) {
    if (!ttsEnabled) {
        return;
    }
    
    if (currentAudio) {
        currentAudio.pause();
    }

    const audio = new Audio("data:audio/mp3;base64," + base64Data);
    currentAudio = audio;
    isSpeaking = true;

    // TTS BAŞLARKEN: Mikrofonu Durdur
    if (recognitionActive && recognition) {
        // recognition.stop() çağrısı onend'i tetikler
        recognition.stop();
        micToggleBtn.classList.remove('active');
        micStatusDiv.textContent = 'Bot Konuşuyor...';
        clearTimeout(silenceTimeout);
    }

    audio.onended = () => {
        isSpeaking = false;
        currentAudio = null;
        
        // TTS BİTERKEN: Başlatma işini recognition.onend'e bırakıyoruz!
        if (!micEnabled) { 
             micStatusDiv.textContent = 'Kapalı';
             micStatusDiv.classList.add('mic-status-hidden');
        }
    };
    
    audio.play().catch(error => {
        console.error("Ses oynatılırken hata:", error);
        isSpeaking = false;
    });
}

// API'ye mesaj gönderir
async function sendMessage(message) {
    if (isBotProcessing || !message.trim()) {
        return;
    }

    isBotProcessing = true;
    setUIEnabled(false);
    
    appendMessage(message, "user");
    userInput.value = ""; 
    
    appendMessage("...", "assistant loading"); 
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: message })
        });

        const loadingMessage = messagesDiv.querySelector('.assistant.loading');
        if (loadingMessage) {
            messagesDiv.removeChild(loadingMessage);
        }

        const data = await response.json();

        if (response.ok) {
            appendMessage(data.answer, "assistant");
            if (data.audio_base64) {
                playAudio(data.audio_base64);
            }
        } else if (response.status === 402) {
            appendMessage(data.answer, "assistant error");
        } else {
            appendMessage(data.error || "Bilinmeyen bir hata oluştu.", "assistant error");
        }
        
        updateStatusDisplay();

    } catch (error) {
        console.error("Mesaj gönderme hatası:", error);
        
        const loadingMessage = messagesDiv.querySelector('.assistant.loading');
        if (loadingMessage) {
            messagesDiv.removeChild(loadingMessage);
        }
        appendMessage("Hata oluştu: Sunucuya ulaşılamadı. Lütfen tekrar deneyin.", "assistant error");
    } finally {
        resetUI();
    }
}

// --- Konuşma Tanıma İşlemleri ---
function setupSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window)) {
        micToggleBtn.style.display = 'none';
        return;
    }

    recognition = new webkitSpeechRecognition();
    recognition.continuous = true; 
    recognition.interimResults = true;
    recognition.lang = 'tr-TR';

    recognition.onstart = function() {
        recognitionActive = true;
        micToggleBtn.classList.add('active');
        micStatusDiv.textContent = 'Dinleniyor...';
        micStatusDiv.classList.remove('mic-status-hidden');
    };

    recognition.onresult = function(event) {
        finalTranscript = '';
        interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        userInput.value = finalTranscript + interimTranscript;
        
        if (finalTranscript) {
            resetSilenceTimeout();
        }
    };

    recognition.onerror = function(event) {
        console.error('Konuşma tanıma hatası:', event.error);
        
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
            alert('HATA: Mikrofon erişimi engellendi. Lütfen tarayıcınızın adres çubuğundaki kilit simgesine tıklayıp mikrofon iznini açın.');
            micEnabled = false; 
        }

        // Hata durumunda da durdur
        stopRecognition(false);
    };

    // KRİTİK DÜZELTME: SÜREKLİ DİNLEME DÖNGÜSÜ BURAYA GELDİ
    recognition.onend = function() {
        recognitionActive = false;
        micToggleBtn.classList.remove('active');
        micStatusDiv.classList.add('mic-status-hidden');
        micStatusDiv.textContent = 'Kapalı'; 
        
        // EĞER KULLANICI MİKROFONU KAPATMADIYSA (micEnabled = true), YENİDEN BAŞLAT
        if (micEnabled) {
            // 100ms gecikme ile başlatarak döngünün temizlenmesine izin ver
            setTimeout(startRecognition, 100); 
        }
    };
}

function startRecognition() {
    if (!recognition || !micEnabled) return;
    try {
        recognition.start();
        resetSilenceTimeout();
    } catch (error) {
        console.error("Tanıma başlatılamadı:", error);
    }
}

function stopRecognition(shouldSend = true) {
    if (!recognition) return;
    
    recognition.stop(); 
    clearTimeout(silenceTimeout);
    
    if (shouldSend && finalTranscript.trim()) {
        sendMessage(finalTranscript);
    }
    finalTranscript = '';
    userInput.value = '';
}

function resetSilenceTimeout() {
    clearTimeout(silenceTimeout);
    silenceTimeout = setTimeout(() => {
        if (recognitionActive) {
            console.log("Sessizlik tespit edildi, otomatik durduruluyor.");
            stopRecognition(true); // Sessizlikten sonra otomatik gönder
        }
    }, SILENCE_THRESHOLD_MS);
}


// --- Olay Dinleyicileri (Toggle Logic Fix) ---
micToggleBtn.addEventListener("click", () => {
    if (micEnabled) {
        if (!recognitionActive) {
            // 1. Durum: Kapalıyken tıklandı -> BAŞLAT
            micEnabled = true; 
            startRecognition();
        } else {
            // 2. Durum: Aktifken tıklandı -> KULLANICI TARAFINDAN KAPAT
            micEnabled = false; // Döngüyü kırmak için bayrağı indir
            stopRecognition(false); // Göndermeden durdur (onend tetiklenecek ama micEnabled false olduğu için yeniden başlamayacak)
            
            micToggleBtn.classList.remove('active');
            micStatusDiv.textContent = 'Kapalı';
            micStatusDiv.classList.add('mic-status-hidden');
        }
    } else {
        // 3. Durum: Kapalıyken (micEnabled=false) tıklandı -> TEKRAR AÇ
        micEnabled = true;
        startRecognition();
    }
});


// --- Three.js ve Animasyon Kodu (Önceki Adımda Bozulan Kısımlar) ---
let scene, camera, renderer, sphere;
let frameCount = 0;

function initThreeJS() {
    if (typeof THREE === 'undefined') {
        console.error("THREE.js yüklenmedi. 3D animasyonu başlatılamıyor.");
        return; 
    }
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
        audioEffect = Math.sin(frameCount) * 0.1 + 0.1;
    } else {
        frameCount = 0; 
    }

    sphere.rotation.x += 0.005;
    sphere.rotation.y += 0.008;

    let scale = baseScale + (Math.sin(Date.now() * 0.001) * 0.1) + audioEffect;
    sphere.scale.set(scale, scale, scale);

    renderer.render(scene, camera);
}


// --- Uygulama Başlangıcı ---
document.addEventListener('DOMContentLoaded', () => {
    updateStatusDisplay(); 
    setupSpeechRecognition();
    initThreeJS();

    // Sayfa yüklendiğinde mikrofonu otomatik başlat
    if (micEnabled && recognition) {
        setTimeout(startRecognition, 100); 
    }
});