// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const messagesDiv = document.getElementById("messages");
const ttsToggleBtn = document.getElementById("ttsToggleBtn"); 
const micToggleBtn = document.getElementById("micToggleBtn"); 
const sendBtn = document.getElementById("sendBtn");
const micStatusDiv = document.getElementById('micStatus'); // Global olarak tanımlandı

// --- Ses ve Durum Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 
let isBotProcessing = false; 
let finalTranscript = '';     // Kesinleşmiş (Final) metinleri tutar
let interimTranscript = '';   // Kesinleşmemiş (Interim) metinleri tutar
let ttsEnabled = true;        
let micEnabled = true;        
let recognitionActive = false;
let silenceTimeout = null;    

// --- AYARLAR ---
const API_URL = "/ask"; 
const SILENCE_THRESHOLD_MS = 1500; // 1.5 saniye sessizlik sonrası otomatik gönder

// --- YENİ EKLENEN FONKSİYON: Kullanıcı Durumunu Yükleme ---
async function updateStatusDisplay() {
    try {
        const response = await fetch('/api/profile');
        if (response.ok) {
            const data = await response.json();
            const statusDiv = document.getElementById('memberStatus');
            
            if (data.is_active_member) {
                // Ücretli üye ise
                statusDiv.innerHTML = 'Aktif Üye <i class="fas fa-check-circle" style="color: #238636;"></i>';
            } else {
                // Demo kullanıcısı ise
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
// --- YENİ EKLENEN FONKSİYON BİTİŞ ---

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
    micToggleBtn.disabled = false;
    sendBtn.disabled = false;
}

// UI elementlerinin etkinliğini kontrol eder
function setUIEnabled(enabled) {
    userInput.disabled = !enabled;
    micToggleBtn.disabled = !enabled;
    sendBtn.disabled = !enabled;
    ttsToggleBtn.disabled = !enabled;
}

// Ses dosyasını oynatır
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

    audio.onended = () => {
        isSpeaking = false;
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
    
    // Yükleniyor mesajı göster
    appendMessage("...", "assistant loading"); 
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: message })
        });

        // Yükleniyor mesajını kaldır
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
            // Demo hakkı bittiğinde 402 döner
            appendMessage(data.answer, "assistant error");
        } else {
            // Diğer hatalar (API hatası dahil)
            appendMessage(data.error || "Bilinmeyen bir hata oluştu.", "assistant error");
        }
        
        // İşlem bittiğinde demo sayacını güncelle (hata olsa da olmasa da güncellenmeli)
        updateStatusDisplay();

    } catch (error) {
        console.error("Mesaj gönderme hatası:", error);
        
        // Yükleniyor mesajını kaldır
        const loadingMessage = messagesDiv.querySelector('.assistant.loading');
        if (loadingMessage) {
            messagesDiv.removeChild(loadingMessage);
        }
        appendMessage("Hata oluştu: Sunucuya ulaşılamadı. Lütfen tekrar deneyin.", "assistant error");
    } finally {
        resetUI();
    }
}

// Mikrofon İşlemleri
function setupSpeechRecognition() {
    // webkitSpeechRecognition kontrolü
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
        // GÜVENLİK KONTROLÜ
        if (micStatusDiv) {
            micStatusDiv.textContent = 'Dinleniyor... Konuşun.';
            micStatusDiv.style.display = 'block'; 
        }
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
        
        if (finalTranscript.trim()) {
            // Kesinleşmiş metin varsa sessizlik zamanlayıcısını yeniden başlat
            resetSilenceTimeout();
        }
    };

    recognition.onerror = function(event) {
        console.error('Konuşma tanıma hatası:', event.error);
        
        // Kullanıcıya izin engellenmesi durumunda bilgi ver
        if(event.error === 'not-allowed') {
             alert("Mikrofon erişimi engellendi. Lütfen tarayıcı ayarlarınızdan izin verin (sadece HTTPS bağlantısında çalışır).");
        }
        
        stopRecognition(false); // Hata durumunda otomatik gönderme
    };

    recognition.onend = function() {
        recognitionActive = false;
        micToggleBtn.classList.remove('active');
        // GÜVENLİK KONTROLÜ
        if (micStatusDiv) {
            micStatusDiv.textContent = '';
            micStatusDiv.style.display = 'none';
        }
    };
}

function startRecognition() {
    if (!recognition) return;
    try {
        recognition.start();
        resetSilenceTimeout();
    } catch (error) {
        console.error("Tanıma başlatılamadı:", error);
    }
}

function stopRecognition(autoSend = true) {
    if (!recognition || !recognitionActive) return;
    
    // Hata oluştuğunda stopRecognition çağrıldığında tekrar stop etmeye çalışmamak için kontrol
    try {
        recognition.stop();
    } catch(e) {
        console.warn("Recognition stop hatası: Muhtemelen zaten durdurulmuştu.");
    }
    
    clearTimeout(silenceTimeout);
    
    // Eğer kesinleşmiş metin varsa ve otomatik gönderme açıksa gönder
    if (autoSend && finalTranscript.trim()) {
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
            stopRecognition();
        }
    }, SILENCE_THRESHOLD_MS);
}


// --- Olay Dinleyicileri ---
userInput.addEventListener("keypress", (e) => {
    if (e.key === 'Enter') {
        sendMessage(userInput.value);
    }
});

sendBtn.addEventListener("click", () => {
    sendMessage(userInput.value);
});

ttsToggleBtn.addEventListener("click", () => {
    ttsEnabled = !ttsEnabled;
    ttsToggleBtn.classList.toggle('active', ttsEnabled);
    ttsToggleBtn.title = ttsEnabled ? "Botun sesli cevap verme özelliğini kapat" : "Botun sesli cevap verme özelliğini aç";

    if (!ttsEnabled && currentAudio) {
        currentAudio.pause();
        isSpeaking = false;
    }
});

micToggleBtn.addEventListener("click", () => {
    // Eğer konuşma tanıma aktifse kapat, değilse başlat
    if (!recognitionActive) {
        startRecognition();
    } else {
        stopRecognition();
    }
});

// --- Three.js Arka Plan Animasyonu ---
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
        // Konuşma sırasında hafif titreşim efekti
        audioEffect = Math.sin(frameCount) * 0.1 + 0.1;
    } else {
        frameCount = 0; 
    }

    sphere.rotation.x += 0.005;
    sphere.rotation.y += 0.008;

    // Boyut animasyonu
    let scale = baseScale + (Math.sin(Date.now() * 0.001) * 0.1) + audioEffect;
    sphere.scale.set(scale, scale, scale);

    renderer.render(scene, camera);
}

// --- Uygulama Başlangıcı ---
window.onload = function() {
    updateStatusDisplay(); 
    setupSpeechRecognition();
    initThreeJS();
}