// --- DOM Elementleri ---
const userInput = document.getElementById("userInput");
const messagesDiv = document.getElementById("messages");
const ttsToggleBtn = document.getElementById("ttsToggleBtn"); 
const micToggleBtn = document.getElementById("micToggleBtn"); 
const sendBtn = document.getElementById("sendBtn");

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
let silenceTimeout = null;    // <--- Sessizlik sayacı için KRİTİK DEĞİŞKEN

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
                // Demo üye ise
                statusDiv.innerHTML = `Demo (${data.demo_chat_count} hakkınız kaldı) <i class="fas fa-hourglass-half" style="color: #ffc107;"></i>`;
            }
        }
    } catch (error) {
        console.error('Durum yüklenirken hata:', error);
        const statusDiv = document.getElementById('memberStatus');
        statusDiv.innerHTML = 'Durum Yüklenemedi <i class="fas fa-times-circle" style="color: #f85149;"></i>';
    }
}


// --- Mesaj Yönetimi ---
function addMessage(sender, text, isError = false) {
    const message = document.createElement('div');
    message.classList.add('message', sender);
    if (isError) {
        message.classList.add('error-message');
    }
    message.innerHTML = `<strong>${sender === 'user' ? 'Sen' : 'Öğretmen'}:</strong> ${text}`;
    messagesDiv.appendChild(message);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function sendMessage() {
    if (isBotProcessing) return; // Bot meşgulken yeni mesaj gönderme

    const messageText = userInput.value.trim();
    if (messageText === "") return;

    isBotProcessing = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gönderiliyor...';

    // Ses tanıma açıksa, gönderimden sonra kapat
    if (recognition && recognitionActive && micEnabled) {
        // Otomatik gönderimde ses tanımayı durdurma (sürekli dinleme olduğu için bu kısım onend'e bırakıldı)
    }

    addMessage('user', messageText);
    userInput.value = ''; // Giriş alanını temizle

    // Yeni mesaj geldiğinde TTS sesini durdur
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = '';
        isSpeaking = false;
    }

    fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: messageText })
    })
    .then(response => response.json())
    .then(data => {
        isBotProcessing = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Gönder';
        
        // Hata kontrolü
        if (data.error) {
            addMessage('bot', data.answer || data.error, true); // Demo hakkı bittiğinde de hata mesajı ver
        } else {
            addMessage('bot', data.answer);
            
            // TTS (Sesli Yanıt)
            if (ttsEnabled && data.audio_base64) {
                playBase64Audio(data.audio_base64);
            }
        }
        updateStatusDisplay(); // Demo hakkı azaldığı için durumu güncelle
    })
    .catch(error => {
        isBotProcessing = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Gönder';
        console.error('API Hatası:', error);
        addMessage('bot', 'Sunucuya bağlanılamadı. Lütfen internet bağlantınızı kontrol edin veya daha sonra tekrar deneyin.', true);
    });
}

function playBase64Audio(base64Data) {
    isSpeaking = true;
    const audio = new Audio('data:audio/mp3;base64,' + base64Data);
    currentAudio = audio;

    audio.onended = () => {
        isSpeaking = false;
        currentAudio = null;
    };

    audio.onerror = () => {
        isSpeaking = false;
        currentAudio = null;
        console.error("Ses oynatılamadı.");
    };

    audio.play().catch(e => {
        isSpeaking = false;
        currentAudio = null;
        console.error("Ses çalma izni reddedildi (Tarayıcı kısıtlaması).", e);
    });
}


// --- Konuşma Tanıma (Speech Recognition) ---
if ('webkitSpeechRecognition' in window) {
    recognition = new webkitSpeechRecognition();
} else {
    // Tarayıcı desteklemiyorsa butonu gizle ve hata mesajı göster.
    micToggleBtn.style.display = 'none';
    addMessage('bot', 'HATA: Tarayıcınız ses tanıma özelliğini desteklemiyor. Lütfen Chrome, Edge veya güncel bir tarayıcı kullanın.', true);
}


// --- startSpeechRecognition Fonksiyonu (SÜREKLİ DİNLEME AKTİF) ---
function startSpeechRecognition() {
    // Sadece henüz başlatılmadıysa başlat
    if (recognitionActive) return;

    recognition.lang = 'tr-TR';
    recognition.continuous = true;  // <--- KRİTİK DÜZELTME: SÜREKLİ DİNLEME AKTİF
    recognition.interimResults = true; // SÜREKLİ AKTİF İÇİN TRUE
    recognition.maxAlternatives = 1;
    
    // Ses dinlemeye başlandığında
    recognition.onstart = () => {
        micToggleBtn.innerHTML = '<i class="fas fa-microphone"></i> Aktif Dinliyor'; 
        userInput.placeholder = "Dinliyorum...";
    };

    // Ses dinleme durursa otomatik tekrar başlat
    recognition.onend = () => {
        if (micEnabled) {
            // Eğer kullanıcı mikrofonu kapatmadıysa, yeniden başlat
            recognition.start();
        } else {
            // Kullanıcı kapattıysa durumu sıfırla
            recognitionActive = false;
            micToggleBtn.classList.remove('active');
            micToggleBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            userInput.placeholder = "Mesajınızı yazın veya mikrofonu açın...";
        }
    };
    
    recognition.start();
    recognitionActive = true;
    micToggleBtn.classList.add('active');
    micToggleBtn.innerHTML = '<i class="fas fa-microphone"></i> Aktif Dinliyor';
}


// --- recognition.onresult Fonksiyonu (Sessizlik Kontrolü ve Gönderme) ---
recognition.onresult = (event) => {
    // Önceki sessizlik sayacını temizle (konuşma devam ediyor demektir)
    clearTimeout(silenceTimeout);

    let currentTranscript = '';
    let isFinal = false;

    for (let i = event.resultIndex; i < event.results.length; ++i) {
        let transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
            finalTranscript += transcript + ' '; // Kesinleşmiş metni topla
            isFinal = true;
        } else {
            interimTranscript = transcript;
        }
    }

    // Kullanıcı giriş alanını anlık metinle güncelle
    userInput.value = (finalTranscript + interimTranscript).trim();


    // 1.5 saniyelik sessizlik sayacını başlat
    silenceTimeout = setTimeout(() => {
        // Eğer kesinleşmiş metin varsa ve bot meşgul değilse gönder
        if (finalTranscript.trim() !== '' && !isBotProcessing) {
            userInput.value = finalTranscript.trim(); // Gönderilecek son metni ayarla
            finalTranscript = ''; // Bir sonraki konuşma için sıfırla
            interimTranscript = ''; // Geçici metni sıfırla
            sendMessage();
        }
    }, SILENCE_THRESHOLD_MS); // 1.5 saniye
};


// --- recognition.onerror Fonksiyonu (İzin Hatası Yakalama) ---
recognition.onerror = (event) => {
    // Hata oluştuğunda mikrofonu kapat ve durumu sıfırla
    if (recognitionActive) {
        recognition.stop();
    }
    recognitionActive = false;
    micToggleBtn.classList.remove('active');
    micToggleBtn.innerHTML = '<i class="fas fa-microphone"></i>'; 
    userInput.placeholder = "Mesajınızı yazın veya mikrofonu açın...";

    // HATA ÇÖZÜMÜ: Kullanıcıya mikrofon izni hatasını göster
    if (event.error === 'not-allowed' || event.error === 'permission-denied') {
        alert('HATA: Mikrofon erişimi engellendi. Lütfen tarayıcınızın adres çubuğundaki kilit simgesine tıklayıp mikrofon iznini açın.');
        console.error('Mikrofon izni reddedildi:', event.error);
        micEnabled = false; // Mikrofonu devre dışı bırak
    } else if (event.error !== 'no-speech') {
        // no-speech hatası (hiç konuşmama) continuous modda normal kabul edilebilir. Diğer hataları göster.
        console.error('Konuşma Tanıma Hatası:', event.error);
        // İsteğe bağlı: alert('Konuşma Tanıma Hatası: ' + event.error);
    }
    // Hata oluştuğu için onend tetiklenmeyecektir, bu yüzden onend kodunu manuel olarak burada çalıştırmıyoruz.
};


// --- Olay Dinleyicileri ---
micToggleBtn.addEventListener('click', () => {
    if (micEnabled) {
        if (!recognitionActive) {
            // Mikrofonu başlat
            startSpeechRecognition();
        } else {
            // Mikrofonu durdur (kullanıcı kapattı)
            micEnabled = false; // onend döngüsünü durdurmak için
            recognition.stop();
            micToggleBtn.classList.remove('active');
            micToggleBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
            userInput.placeholder = "Mesajınızı yazın veya mikrofonu açın...";
        }
    } else {
        // Eğer izin reddi nedeniyle kapalıysa, yeniden başlatmayı dene
        micEnabled = true;
        startSpeechRecognition();
    }
});


ttsToggleBtn.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    if (ttsEnabled) {
        ttsToggleBtn.classList.add('active');
        ttsToggleBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
        // Konuşma aktif ise (ses kapandıysa) durdur
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            isSpeaking = false;
        }
    } else {
        ttsToggleBtn.classList.remove('active');
        ttsToggleBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
    }
});

sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        sendMessage();
    }
});


// --- Sayfa Yüklendiğinde ---
document.addEventListener('DOMContentLoaded', () => {
    updateStatusDisplay();
    // Sayfa yüklendiğinde mikrofonu otomatik başlat
    if (micEnabled && recognition) {
        startSpeechRecognition();
    }

    // Canvas ve 3D efektleri başlat
    if (document.getElementById('bgCanvas')) {
        initThreeJS();
    }
});

// ===================================
// 3D Küre Efekti (THREE.js) Kodu
// ===================================

let scene, camera, renderer, sphere;
let frameCount = 0;

function initThreeJS() {
    const canvas = document.getElementById('bgCanvas');
    const width = window.innerWidth;
    const height = window.innerHeight;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
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
    sphere.rotation.y += 0.005;
    sphere.scale.setScalar(baseScale + audioEffect);

    renderer.render(scene, camera);
}