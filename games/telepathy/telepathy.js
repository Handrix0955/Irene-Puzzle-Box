const ICON_A = '<svg class="icon-a" viewBox="0 0 24 24" aria-hidden="true"><use href="#telepathy-star"/></svg>';
const ICON_B = '<svg class="icon-b" viewBox="0 0 24 24" aria-hidden="true"><use href="#telepathy-star"/></svg>';
const SETUP_PROMPT = '请在下方输入你的 4 位灵犀密码，然后点击确认';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PVE_ATTEMPTS = 20;
const CONNECTION_TIMEOUT = 15000;

let sessionId = 0;
const sessionTimers = new Set();
const sessionListeners = [];
let connectionTimer = null;
let peer = null;
let conn = null;
let isHost = false;
let gameMode = 'hard';
let gameState = 'LOBBY';
let mySecret = [];
let oppSecret = [];
const currentGuess = [];
let attemptsLeft = MAX_PVE_ATTEMPTS;
let iWon = false;
let oppWon = false;
let keyPress = null;

const peerOptions = {
    debug: 2,
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.qq.com:3478' },
            { urls: 'stun:stun.miwifi.com:3478' }
        ]
    }
};

function $(id) { return document.getElementById(id); }

const keys = document.querySelectorAll('.key');
const submitKey = document.querySelector('.submit-key');
const gameContainer = $('game-container');
const lobbyContainer = $('lobby-container');
const setupPrompt = $('pvp-setup-prompt');
const dualTrack = $('dual-track');
const myGuesses = $('my-guesses');
const oppGuesses = $('her-guesses');
const lobbyButtons = document.querySelectorAll('#connection-menu button');

function updateTopStatus(text, active = false) {
    document.querySelectorAll('.status-text').forEach(el => { el.textContent = text; });
    const color = active ? '#10b981' : '#f59e0b';
    document.querySelectorAll('.status-dot').forEach(el => {
        el.style.backgroundColor = color;
        el.style.boxShadow = '0 0 8px ' + color;
    });
}

function canSubmit() {
    return gameState === 'SETTING_SECRET' || gameState === 'MY_TURN' || gameState === 'PVE_TURN';
}

function canEditInput() {
    return canSubmit() || gameState === 'OPP_TURN';
}

function setGameState(state) {
    gameState = state;
    const locked = !canSubmit();
    submitKey.classList.toggle('locked', locked);
    submitKey.setAttribute('aria-disabled', String(locked));
}

function showGame() {
    lobbyContainer.style.display = 'none';
    gameContainer.style.display = 'flex';
}

function showLobby() {
    setGameState('LOBBY');
    gameContainer.style.display = 'none';
    lobbyContainer.style.display = 'flex';
    $('connection-menu').style.display = 'block';
    $('connection-waiting').style.display = 'none';
    $('my-room-code').textContent = '....';
    lobbyButtons.forEach(button => { button.disabled = false; });
    updateTopStatus('请建立连接');
}

function scheduleForSession(currentSessionId, callback, delay) {
    const timer = setTimeout(() => {
        sessionTimers.delete(timer);
        if (currentSessionId === sessionId) callback();
    }, delay);
    sessionTimers.add(timer);
    return timer;
}

function cancelSessionTimer(timer) {
    clearTimeout(timer);
    sessionTimers.delete(timer);
}

function listenForSession(emitter, event, currentSessionId, callback) {
    const listener = (...args) => {
        if (currentSessionId === sessionId) callback(...args);
    };
    emitter.on(event, listener);
    sessionListeners.push(() => emitter.off(event, listener));
}

function clearRound() {
    mySecret = [];
    oppSecret = [];
    iWon = false;
    oppWon = false;
    attemptsLeft = MAX_PVE_ATTEMPTS;
    currentGuess.length = 0;
    keyPress = null;
    keys.forEach(key => key.classList.remove('draft-dimmed'));
    for (const list of [myGuesses, oppGuesses]) {
        list.replaceChildren();
        list.scrollLeft = 0;
        list.scrollTop = 0;
    }
    setupPrompt.textContent = SETUP_PROMPT;
    setupPrompt.style.display = 'none';
    dualTrack.style.display = 'flex';
    $('her-track-title').textContent = '宝宝进度';
    hideCoin();
    $('coin-result-text').textContent = '';
    $('coin-result-text').style.opacity = '0';
    $('flip-coin').style.transition = 'none';
    $('flip-coin').style.transform = 'rotateY(0deg)';
    renderInput();
}

function closeSession(currentSessionId, message) {
    if (currentSessionId !== sessionId || gameState === 'LOBBY') return;
    sessionId++;
    sessionTimers.forEach(clearTimeout);
    sessionTimers.clear();
    connectionTimer = null;
    sessionListeners.splice(0).forEach(removeListener => removeListener());

    const oldConn = conn;
    const oldPeer = peer;
    conn = null;
    peer = null;
    isHost = false;
    try { oldConn?.close(); } catch (err) { console.warn('关闭数据连接失败', err); }
    try { oldPeer?.destroy(); } catch (err) { console.warn('销毁 Peer 失败', err); }

    clearRound();
    $('rulesModal').style.display = 'none';
    const messageModal = $('messageModal');
    if (messageModal) messageModal.style.display = 'none';
    showLobby();
    if (message) showAppMessage(message.title, message.body, message.color);
}

function quitMatch() {
    if (gameState === 'LOBBY') return;
    const currentSessionId = sessionId;
    if (confirm('确定要退出当前房间吗？进度将会丢失。')) closeSession(currentSessionId);
}

function failOnline(currentSessionId, err) {
    if (currentSessionId !== sessionId) return;
    if (err) console.warn('[telepathy] connection error', err);
    const inGame = conn?.open || (gameState !== 'CONNECTING' && gameState !== 'WAIT_MODE');
    closeSession(currentSessionId, inGame
        ? { title: '连接已断开', body: '与宝宝的连接已断开，已返回联机大厅。', color: '#f59e0b' }
        : { title: '连接失败', body: '请确认房间码、双方的网络和在线状态，再试一次。', color: '#ef4444' });
}

function armConnectionTimeout(currentSessionId) {
    cancelSessionTimer(connectionTimer);
    connectionTimer = scheduleForSession(currentSessionId, () => {
        closeSession(currentSessionId, {
            title: '连接超时', body: '未能建立联机，请检查网络后重试。', color: '#ef4444'
        });
    }, CONNECTION_TIMEOUT);
}

function clearConnectionTimeout() {
    cancelSessionTimer(connectionTimer);
    connectionTimer = null;
}

function createRoom() {
    let code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    startOnline(true, code);
}

function joinRoom() {
    const code = $('join-code-input').value.trim().toUpperCase();
    if (!code) return;
    if (code.length !== 4 || [...code].some(char => !ROOM_CHARS.includes(char))) {
        showAppMessage('房间码无效', '请输入对方分享的 4 位房间码。', '#ef4444');
        return;
    }
    startOnline(false, code);
}

function startOnline(host, code) {
    if (gameState !== 'LOBBY') return;
    if (typeof Peer === 'undefined') {
        showAppMessage('无法联机', '网络库未加载，请检查网络后重试。', '#ef4444');
        return;
    }

    const currentSessionId = ++sessionId;
    isHost = host;
    gameMode = $('mode-select').value;
    setGameState('CONNECTING');
    lobbyButtons.forEach(button => { button.disabled = true; });
    if (host) {
        $('connection-menu').style.display = 'none';
        $('connection-waiting').style.display = 'block';
    }
    updateTopStatus(host ? '连接服务器中...' : '正在连接房间 ' + code + ' ...');
    armConnectionTimeout(currentSessionId);

    const id = 'irene-pbox-' + code;
    try {
        peer = host ? new Peer(id, peerOptions) : new Peer(peerOptions);
    } catch (err) {
        failOnline(currentSessionId, err);
        return;
    }

    listenForSession(peer, 'error', currentSessionId, err => {
        // 信令服务器断线时，已建立的数据通道仍可能可用。
        if (err?.type !== 'network' || !conn?.open) failOnline(currentSessionId, err);
    });
    listenForSession(peer, 'disconnected', currentSessionId, () => {
        if (!conn?.open) failOnline(currentSessionId);
    });
    listenForSession(peer, 'close', currentSessionId, () => failOnline(currentSessionId));

    if (host) {
        listenForSession(peer, 'open', currentSessionId, () => {
            clearConnectionTimeout();
            $('my-room-code').textContent = code;
            updateTopStatus('等待对方加入');
        });
        listenForSession(peer, 'connection', currentSessionId, connection => {
            if (conn) {
                connection.close();
                return;
            }
            armConnectionTimeout(currentSessionId);
            bindConnection(connection, currentSessionId);
        });
    } else {
        listenForSession(peer, 'open', currentSessionId, () => {
            let connection;
            try {
                connection = peer.connect(id, { reliable: true });
            } catch (err) {
                failOnline(currentSessionId, err);
                return;
            }
            if (currentSessionId !== sessionId) return;
            if (connection) bindConnection(connection, currentSessionId);
            else failOnline(currentSessionId);
        });
    }
}

function bindConnection(connection, currentSessionId) {
    conn = connection;
    listenForSession(connection, 'close', currentSessionId, () => failOnline(currentSessionId));
    listenForSession(connection, 'error', currentSessionId, err => failOnline(currentSessionId, err));
    listenForSession(connection, 'data', currentSessionId, handlePeerMessage);

    const open = () => {
        if (gameState !== 'CONNECTING') return;
        showGame();
        dualTrack.style.display = 'none';
        setupPrompt.style.display = 'block';
        if (isHost) {
            clearConnectionTimeout();
            enterSecretSetting();
            sendOnline({ type: 'MODE', data: gameMode });
        } else {
            armConnectionTimeout(currentSessionId);
            setGameState('WAIT_MODE');
            setupPrompt.textContent = '正在同步联机模式...';
            updateTopStatus('等待房主同步模式');
        }
    };
    listenForSession(connection, 'open', currentSessionId, open);
    if (connection.open) open();
}

function sendOnline(payload) {
    const currentSessionId = sessionId;
    try {
        if (!conn?.open) {
            failOnline(currentSessionId);
            return false;
        }
        const sent = conn.send(payload);
        sent?.catch(err => failOnline(currentSessionId, err));
        return currentSessionId === sessionId;
    } catch (err) {
        failOnline(currentSessionId, err);
        return false;
    }
}

function enterSecretSetting() {
    setGameState('SETTING_SECRET');
    setupPrompt.textContent = SETUP_PROMPT;
    updateTopStatus('联机设密 | 请输入你的 4 位底牌');
    renderInput();
}

function validDigits(digits) {
    return Array.isArray(digits) && digits.length === 4
        && [...digits].every(digit => typeof digit === 'string' && /^[0-9]$/.test(digit))
        && (gameMode === 'easy' || new Set(digits).size === 4);
}

function handlePeerMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    const awaitingOpponent = gameState === 'OPP_TURN' || gameState === 'WAIT_OPP_FINISH';
    switch (payload.type) {
        case 'MODE':
            if (isHost || gameState !== 'WAIT_MODE' || !['hard', 'easy'].includes(payload.data)) return;
            gameMode = payload.data;
            clearConnectionTimeout();
            enterSecretSetting();
            break;
        case 'READY':
            if ((gameState !== 'SETTING_SECRET' && gameState !== 'WAIT_READY') || oppSecret.length || !validDigits(payload.secret)) return;
            oppSecret = payload.secret.slice();
            checkPvpStart();
            break;
        case 'COIN':
            if (!isHost && gameState === 'COIN_TOSS' && typeof payload.data?.isHostFirst === 'boolean') {
                startTurns(payload.data.isHostFirst);
            }
            break;
        case 'GUESS':
            if (awaitingOpponent && !oppWon && validDigits(payload.data?.guess)) {
                const guess = payload.data.guess;
                appendGuess(oppGuesses, guess, evaluateGuess(guess, mySecret));
            }
            break;
        case 'WIN':
            if (!awaitingOpponent || oppWon) return;
            oppWon = true;
            if (iWon) {
                finishPvp();
            } else {
                setGameState('MY_TURN');
                updateTopStatus('你的回合 (对方已破译)', true);
                showAppMessage('对方已破译', '宝宝率先破译了你的底牌！你可以继续破译直到成功。', '#f59e0b');
            }
            break;
        case 'TURN_PASS':
            if (gameState !== 'OPP_TURN' || oppWon) return;
            setGameState('MY_TURN');
            updateTopStatus('你的回合', true);
            navigator.vibrate?.(100);
            break;
    }
}

function checkPvpStart() {
    if (gameState !== 'WAIT_READY' || oppSecret.length !== 4) return;
    setGameState('COIN_TOSS');
    setupPrompt.style.display = 'none';
    dualTrack.style.display = 'flex';
    updateTopStatus('抛硬币 | 争夺先手...');
    if (isHost) {
        const isHostFirst = Math.random() > 0.5;
        if (sendOnline({ type: 'COIN', data: { isHostFirst } })) startTurns(isHostFirst);
    }
}

function startTurns(isHostFirst) {
    const myTurnFirst = isHost === isHostFirst;
    setGameState(myTurnFirst ? 'MY_TURN' : 'OPP_TURN');
    updateTopStatus(myTurnFirst ? '你的回合' : '对方回合，请等待', myTurnFirst);
    playCoinToss(myTurnFirst, isHostFirst, sessionId);
}

function playCoinToss(myTurnFirst, isHostFirst, currentSessionId) {
    const coin = $('flip-coin');
    const result = $('coin-result-text');
    const rotation = isHostFirst ? 1800 : 1980;
    gameContainer.classList.add('coin-tossing');
    $('coin-modal').style.display = 'flex';
    result.style.opacity = '0';
    // 先应用重置后的角度，确保新一局抽到相同先手时也有过渡。
    coin.getBoundingClientRect();
    coin.style.transition = 'transform 3s cubic-bezier(0.2, 0.8, 0.2, 1)';
    coin.style.transform = 'rotateY(' + rotation + 'deg)';
    navigator.vibrate?.([40, 60, 40]);

    scheduleForSession(currentSessionId, () => {
        result.textContent = myTurnFirst ? '你获得了先手！' : '对方获得了先手！';
        result.style.color = myTurnFirst ? '#10b981' : '#f59e0b';
        result.style.opacity = '1';
        navigator.vibrate?.(80);
        scheduleForSession(currentSessionId, hideCoin, 2000);
    }, 3000);
}

function hideCoin() {
    $('coin-modal').style.display = 'none';
    gameContainer.classList.remove('coin-tossing');
}

function startOfflinePVE() {
    if (gameState !== 'LOBBY') return;
    sessionId++;
    gameMode = $('mode-select').value;
    clearRound();
    const pool = Array.from('0123456789');
    for (let i = 0; i < 4; i++) {
        const index = Math.floor(Math.random() * pool.length);
        oppSecret.push(gameMode === 'easy' ? pool[index] : pool.splice(index, 1)[0]);
    }

    const note = document.createElement('div');
    note.className = 'practice-note';
    note.textContent = '当前为单机 PVE 练习模式';
    oppGuesses.append(note);
    showGame();
    setGameState('PVE_TURN');
    renderAttempts();
}

function renderAttempts() {
    const mode = gameMode === 'easy' ? '轻松' : '硬核';
    updateTopStatus('单机演练 | ' + mode + ' · 剩余 ' + attemptsLeft + ' 次', true);
}

function evaluateGuess(guess, secret) {
    let a = 0;
    let b = 0;
    const counts = new Map();
    for (let i = 0; i < 4; i++) {
        if (guess[i] === secret[i]) a++;
        else counts.set(secret[i], (counts.get(secret[i]) || 0) + 1);
    }
    if (gameMode === 'hard') {
        for (let i = 0; i < 4; i++) {
            const count = counts.get(guess[i]);
            if (guess[i] === secret[i] || !count) continue;
            b++;
            counts.set(guess[i], count - 1);
        }
    }
    return { a, b };
}

function renderInput() {
    document.querySelectorAll('.digit-slot').forEach((slot, index) => {
        slot.textContent = currentGuess[index] ?? '';
        slot.classList.toggle('filled', index < currentGuess.length);
    });
    document.querySelectorAll('.key[data-num]').forEach(key => {
        key.classList.toggle('key-disabled', gameMode === 'hard' && currentGuess.includes(key.dataset.num));
    });
}

function appendGuess(list, guess, { a, b }) {
    const row = document.createElement('div');
    row.className = 'guess-item';
    const digits = document.createElement('span');
    digits.className = 'nums';
    digits.textContent = guess.join(' ');
    const result = document.createElement('span');
    result.className = 'result';
    result.innerHTML = ICON_A.repeat(a) + ICON_B.repeat(b);
    const label = document.createElement('span');
    label.className = 'result-label';
    label.textContent = a + 'A' + b + 'B';
    result.append(label);
    row.append(digits, result);
    list.prepend(row);
}

function submitGuess() {
    if (!canSubmit() || !validDigits(currentGuess)) return;
    const guess = currentGuess.splice(0);
    renderInput();
    playSound('bubble');

    if (gameState === 'SETTING_SECRET') {
        mySecret = guess;
        setGameState('WAIT_READY');
        $('her-track-title').textContent = '宝宝进度 (我的底牌: ' + mySecret.join('') + ')';
        setupPrompt.textContent = '等待对方就绪...';
        updateTopStatus('底牌已锁定 | 等待对方就绪...');
        if (sendOnline({ type: 'READY', secret: mySecret })) checkPvpStart();
        return;
    }

    const result = evaluateGuess(guess, oppSecret);
    appendGuess(myGuesses, guess, result);
    if (gameState === 'PVE_TURN') {
        attemptsLeft--;
        if (result.a === 4 || attemptsLeft === 0) finishPve(result.a === 4);
        else renderAttempts();
        return;
    }

    if (!sendOnline({ type: 'GUESS', data: { guess, ...result } })) return;
    if (result.a === 4) {
        iWon = true;
        if (!sendOnline({ type: 'WIN' })) return;
        if (oppWon) {
            finishPvp();
        } else {
            setGameState('WAIT_OPP_FINISH');
            updateTopStatus('已破译 | 等待对方破译', true);
            const secret = oppSecret.join('');
            scheduleForSession(sessionId, () => {
                if (gameState === 'WAIT_OPP_FINISH') {
                    showAppMessage('破译成功！', '正确底牌是 ' + secret + '。等待宝宝破译你的底牌。', '#10b981');
                }
            }, 500);
        }
    } else if (!oppWon) {
        setGameState('OPP_TURN');
        updateTopStatus('对方回合，请等待');
        sendOnline({ type: 'TURN_PASS' });
    }
}

function finishPvp() {
    setGameState('GAMEOVER');
    updateTopStatus('对局圆满结束', true);
    const secret = oppSecret.join('');
    scheduleForSession(sessionId, () => {
        showAppMessage('双向奔赴！', '正确底牌是 ' + secret + '。双方均已成功破译！', '#10b981');
    }, 500);
}

function finishPve(won) {
    setGameState('GAMEOVER');
    updateTopStatus(won ? '单机破译成功' : '20 次机会已用尽', won);
    const currentSessionId = sessionId;
    const secret = oppSecret.join('');
    scheduleForSession(currentSessionId, () => {
        const prefix = won ? '正确底牌是 ' : '20 次机会已用尽，正确底牌是 ';
        showAppMessage(won ? '破译成功！' : '破译失败', prefix + secret + '。点击下方按钮开始下一局。', won ? '#10b981' : '#ef4444');
        const button = $('msgCloseBtn');
        const restart = () => {
            if (currentSessionId !== sessionId) return;
            closeSession(currentSessionId);
            startOfflinePVE();
        };
        button.textContent = '再来一局';
        button.addEventListener('click', restart, { once: true });
        sessionListeners.push(() => {
            button.removeEventListener('click', restart);
            button.textContent = '知道啦！';
        });
    }, 500);
}

keys.forEach(key => {
    key.addEventListener('contextmenu', event => event.preventDefault());
    key.addEventListener('pointerdown', event => {
        if (!canEditInput() || keyPress || event.button !== 0 || (key === submitKey && !canSubmit())) return;
        const press = { key, pointerId: event.pointerId, currentSessionId: sessionId, long: false };
        try { key.setPointerCapture(event.pointerId); } catch {}
        keyPress = press;
        press.timer = scheduleForSession(press.currentSessionId, () => {
            if (!canEditInput()) return;
            press.long = true;
            if (key.dataset.num !== undefined) {
                key.classList.toggle('draft-dimmed');
                navigator.vibrate?.(50);
            }
        }, 400);
    });
    const endPress = event => {
        if (keyPress?.key !== key || keyPress.pointerId !== event.pointerId) return;
        const press = keyPress;
        keyPress = null;
        cancelSessionTimer(press.timer);
        if (event.type !== 'pointerup' || press.currentSessionId !== sessionId || press.long || !canEditInput()) return;
        if (key === submitKey) {
            submitGuess();
        } else if (key.classList.contains('del-key')) {
            currentGuess.pop();
            renderInput();
        } else if (!key.classList.contains('draft-dimmed') && currentGuess.length < 4) {
            const digit = key.dataset.num;
            if (gameMode === 'hard' && currentGuess.includes(digit)) return;
            currentGuess.push(digit);
            renderInput();
        }
    };
    key.addEventListener('pointerup', endPress);
    key.addEventListener('pointercancel', endPress);
    key.addEventListener('lostpointercapture', endPress);
});

$('create-room-btn').addEventListener('click', createRoom);
$('join-room-btn').addEventListener('click', joinRoom);
$('offline-btn').addEventListener('click', startOfflinePVE);
for (const id of ['quit-btn-lobby', 'quit-btn-game']) $(id).addEventListener('click', quitMatch);
for (const id of ['rules-btn', 'rules-btn-game']) {
    $(id).addEventListener('click', () => { $('rulesModal').style.display = 'flex'; });
}
$('rules-close-btn').addEventListener('click', () => closeModal('rulesModal'));

function syncGameThemeIcon() {
    $('theme-icon-game').innerHTML = $('theme-icon').innerHTML;
}
for (const id of ['theme-btn', 'theme-btn-game']) {
    $(id).addEventListener('click', () => { toggleTheme(); syncGameThemeIcon(); });
}
syncGameThemeIcon();
showLobby();
