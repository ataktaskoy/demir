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

    // KRİTİK DÜZELTME: BOT KONUŞURKEN MİKROFONU DURDUR
    if (recognitionActive && recognition) {
        recognition.stop();
        // UI Güncelleme (Bot konuşuyor)
        micToggleBtn.classList.remove('active');
        const micStatusDiv = document.getElementById('micStatus');
        micStatusDiv.textContent = 'Bot Konuşuyor...';
        // Sessizlik zamanlayıcısını da temizle (yanlış tetiklemeyi önler)
        clearTimeout(silenceTimeout);
    }


    audio.onended = () => {
        isSpeaking = false;
        currentAudio = null;
        
        // BOT KONUŞMASI BİTERKEN MİKROFONU TEKRAR BAŞLAT
        if (micEnabled) {
             startRecognition();
        } else {
             // Kullanıcı kapattıysa, sadece UI'ı güncelle.
             const micStatusDiv = document.getElementById('micStatus');
             micStatusDiv.textContent = 'Kapalı';
             micStatusDiv.classList.add('mic-status-hidden');
             micToggleBtn.classList.remove('active');
        }
    };
    
    audio.play().catch(error => {
        console.error("Ses oynatılırken hata:", error);
        isSpeaking = false;
        
        // Hata durumunda da mikrofonu geri aç
        if (micEnabled) {
            startRecognition();
        }
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
    if (!('webkitSpeechRecognition' in window)) {
        micToggleBtn.style.display = 'none';
        return;
    }

    recognition = new webkitSpeechRecognition();
    recognition.continuous = true; 
    recognition.interimResults = true;
    recognition.lang = 'tr-TR';
    
    const micStatusDiv = document.getElementById('micStatus');

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
            // Kesinleşmiş metin varsa sessizlik zamanlayıcısını yeniden başlat
            resetSilenceTimeout();
        }
    };

    recognition.onerror = function(event) {
        console.error('Konuşma tanıma hatası:', event.error);
        
        // İzin hatası ise kullanıcıyı uyar ve micEnabled'ı kapat
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
            alert('HATA: Mikrofon erişimi engellendi. Lütfen tarayıcınızın adres çubuğundaki kilit simgesine tıklayıp mikrofon iznini açın.');
            micEnabled = false; 
        }

        stopRecognition(false); // Otomatik göndermeden durdur
        
        // Eğer micEnabled true ise (izin varsa), yeniden başlatmayı dene
        if (micEnabled) {
            startRecognition();
        }

    };

    recognition.onend = function() {
        recognitionActive = false;
        micToggleBtn.classList.remove('active');
        micStatusDiv.classList.add('mic-status-hidden');
        
        // KULLANICI İZİN VERMİŞ VE MİKROFON AÇIKSA, OTOMATİK YENİDEN BAŞLATMAYI DENERİZ (SÜREKLİ DİNLEME İÇİN)
        // Ancak bu mantık, playAudio'dan gelen stop'u da yakalayacağı için 
        // bot konuşması bittiğinde playAudio içinde startRecognition() çağrısı yapılmaktadır.
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
    
    // onend'in çağrılmasını sağlar
    recognition.stop(); 
    clearTimeout(silenceTimeout);
    
    // Eğer kesinleşmiş metin varsa ve gönderim isteniyorsa otomatik gönder
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
    ttsToggleBtn