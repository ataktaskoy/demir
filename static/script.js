// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const messagesDiv = document.getElementById("messages");
const recordBtn = document.getElementById("recordBtn");

// --- Ses Kontrolü ---
let currentAudio = null;
let isSpeaking = false; 
let recognition = null; 

// --- API Ayarları ---
// HATA DÜZELTME: Render'da çalışmak için sadece göreceli yol kullanıyoruz
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
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    const audioUrl = `data:audio/mpeg;base64,${base64Data}`;
    currentAudio = new Audio(audioUrl);
    
    // Ses başladığında animasyonu etkinleştir
    currentAudio.onplay = () => {
        isSpeaking = true;
    };
    
    // Ses bittiğinde animasyonu devre dışı bırak
    currentAudio.onended = () => {
        isSpeaking = false;
    };
    
    currentAudio.play().catch(error => {
        console.error("Audio playback failed:", error);
        isSpeaking = false; 
    });
}

// --- AKTİF MİKROFONU GÜVENLİ ŞEKİLDE DURDURMA FONKSİYONU ---
function stopRecognitionIfActive() {
    if (recognition) {
        try {
            recognition.stop();
        } catch (e) {
            console.warn("Recognition zaten durmuştu veya durdurulurken hata oluştu.");
        }
        recognition = null;
        recordBtn.innerText = "Mikrofon";
        recordBtn.classList.remove("listening");
        userInput.placeholder = "Sorunu yaz...";
    }
}

// --- Mesaj Gönderme Fonksiyonu ---
async function sendMessage(text) {
    if (!text) return;
    
    stopRecognitionIfActive(); 
    
    appendMessage(text, "user");
    userInput.value = "";
    sendBtn.disabled = true;

    try {
        // API_URL artık /ask olarak ayarlandığı için Render adresine gidecektir.
        const response = await fetch(API_URL, { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message: text })
        });

        const data = await response.json();
        if (data.error) {
            // Sunucudan gelen hata mesajını göster
            appendMessage("Hata: " + data.error, "bot");
        } else {
            appendMessage(data.answer, "bot");
            if (data.audio_base64) {
                playAudioFromBase64(data.audio_base64);
            }
        }
    } catch (error) {
        // Sunucuya hiç ulaşılamadığında bu hata çıkar
        appendMessage("Sunucuya ulaşılamıyor. Lütfen Render'daki uygulamanın 'Live' olduğundan emin olun.", "bot");
        console.error("Fetch error:", error);
    } finally {
        sendBtn.disabled = false;
    }
}

// --- Sesli Komut Fonksiyonu (Web Speech API) ---
function startVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        alert("Üzgünüm, tarayıcınız Ses Tanıma özelliğini desteklemiyor. Lütfen Chrome veya Edge kullanın.");
        return;
    }

    if (recognition) {
        stopRecognitionIfActive();
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'tr-TR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
        recordBtn.innerText = "Dinliyor...";
        recordBtn.classList.add("listening");
        userInput.placeholder = "Şimdi konuşun...";
    };

    recognition.onresult = (event) => {
        const speechToText = event.results[0][0].transcript;
        userInput.value = speechToText;
        sendMessage(speechToText); 
    };

    recognition.onend = () => {
        stopRecognitionIfActive();
    };

    recognition.onerror = (event) => {
        console.error('Ses Tanıma Hatası:', event.error);
        alert(`Ses Tanıma Hatası: ${event.error}`);
        stopRecognitionIfActive();
    };

    recognition.start();
}

// --- Olay Dinleyicileri ---
sendBtn.addEventListener("click", () => {
    sendMessage(userInput.value);
});

userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
        sendMessage(userInput.value);
    }
});

recordBtn.addEventListener("click", startVoiceRecognition);


// --- Three.js Animasyonu (Sese Duyarlı Balon/Dalga) ---
let scene, camera, renderer, sphere;
let frameCount = 0;

function initThreeJS() {
    const canvas = document.getElementById("bgCanvas");
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
        audioEffect = 0;
    }

    const scaleFactor = baseScale + audioEffect;
    
    sphere.scale.set(scaleFactor, scaleFactor, scaleFactor);
    
    sphere.rotation.x += 0.003;
    sphere.rotation.y += 0.005;

    renderer.render(scene, camera);
}

// Sayfa yüklendiğinde animasyonu başlat
window.onload = initThreeJS;