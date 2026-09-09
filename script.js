document.addEventListener('DOMContentLoaded', () => {
    const videoElement = document.getElementById('webcam');
    const canvasElement = document.getElementById('output_canvas');

    if (!videoElement || !canvasElement) {
        console.error('Elemen video atau canvas tidak ditemukan di HTML!');
        return;
    }

    const canvasCtx = canvasElement.getContext('2d');
    if (!canvasCtx) {
        console.error('2D context tidak tersedia pada canvas!');
        return;
    }

    // --- SOS UI helpers (creates a fixed column to show sos triggers) ---
    // Styling now lives in index.html's <style> (.sos-column / .sos-column-title / .sos-entry)
    // instead of being set inline here — easier to read and easier to re-theme later.
    function ensureSosColumn() {
        let sosCol = document.getElementById('sos_column');
        if (!sosCol) {
            sosCol = document.createElement('div');
            sosCol.id = 'sos_column';
            sosCol.className = 'sos-column';
            const title = document.createElement('div');
            title.className = 'sos-column-title';
            title.textContent = 'SOS Log';
            sosCol.appendChild(title);
            document.body.appendChild(sosCol);
        }
        return sosCol;
    }

    function sosTriggered(handIndex) {
        const sosCol = ensureSosColumn();
        const entry = document.createElement('div');
        entry.className = 'sos-entry';
        const ts = new Date().toLocaleTimeString();
        entry.textContent = `${ts} — sos (hand ${handIndex + 1})`;
        sosCol.appendChild(entry);
        sosCol.scrollTop = sosCol.scrollHeight;
        try { entry.animate([{ transform: 'translateY(-6px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'ease-out' }); } catch (e) { }
        // remove after 10s
        setTimeout(() => { try { entry.remove(); } catch (e) { } }, 10000);
    }

    // Error overlay
    const errorOverlay = document.getElementById('error_overlay');
    const errorMessageEl = document.getElementById('error_message');
    const errorClose = document.getElementById('error_close');
    function showError(msg) {
        if (errorMessageEl) errorMessageEl.textContent = msg;
        if (errorOverlay) {
            errorOverlay.classList.remove('hidden');
            errorOverlay.setAttribute('aria-hidden', 'false');
        } else alert(msg);
    }
    function hideError() {
        if (errorOverlay) {
            errorOverlay.classList.add('hidden');
            errorOverlay.setAttribute('aria-hidden', 'true');
        }
    }
    if (errorClose) errorClose.addEventListener('click', hideError);

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // camera state — declared early since several sections below need to read/update it
    let camera = null;
    let cameraRunning = false;

    // ---------- Persistent settings (localStorage) ----------
    // Two things get remembered between visits: the finger-detection thresholds
    // (set via the "Kalibrasi" button) and the SOS motion sensitivity (slider).
    const STORAGE_KEY_THRESHOLDS = 'handreader_finger_thresholds_v1';
    const STORAGE_KEY_SENSITIVITY = 'handreader_sos_sensitivity_v1';

    const DEFAULT_THRESHOLDS = {
        cosThreshold: -0.55,
        distRatioThreshold: 1.12,
        thumbProjThreshold: 0.03,
        thumbDistRatioThreshold: 0.95,
        thumbIndexRatio: 0.55
    };

    function loadThresholds() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_THRESHOLDS);
            if (!raw) return { ...DEFAULT_THRESHOLDS };
            return { ...DEFAULT_THRESHOLDS, ...JSON.parse(raw) };
        } catch (e) {
            console.warn('Gagal memuat kalibrasi tersimpan, pakai default.', e);
            return { ...DEFAULT_THRESHOLDS };
        }
    }
    function saveThresholds(t) {
        try { localStorage.setItem(STORAGE_KEY_THRESHOLDS, JSON.stringify(t)); } catch (e) { console.warn('Gagal menyimpan kalibrasi', e); }
    }
    let thresholds = loadThresholds();

    function loadSensitivity() {
        const raw = Number(localStorage.getItem(STORAGE_KEY_SENSITIVITY));
        return Number.isFinite(raw) && raw >= 1 && raw <= 10 ? raw : 5;
    }
    function saveSensitivity(v) {
        try { localStorage.setItem(STORAGE_KEY_SENSITIVITY, String(v)); } catch (e) { /* ignore */ }
    }
    let sosSensitivity = loadSensitivity();

    // Turns a 1–10 "sensitivity" dial into the actual motion-detection parameters.
    // Higher sensitivity = a smaller wiggle counts as SOS, and it can re-trigger sooner.
    function motionParamsFromSensitivity(level) {
        const t = (level - 1) / 9; // 0 (insensitive) .. 1 (very sensitive)
        return {
            dirChanges: Math.round(6 - t * 3),       // 6 -> 3 direction changes needed
            amplitude: 0.20 - t * 0.13,               // 0.20 -> 0.07 normalized coords
            cooldownMs: Math.round(4000 - t * 2000)   // 4000ms -> 2000ms between triggers
        };
    }
    let motionParams = motionParamsFromSensitivity(sosSensitivity);
    const MOTION_WINDOW_MS = 1500; // how far back we look for a waving pattern

    // smoothing history for counts
    const HISTORY_SIZE = 6;
    // per-hand smoothing and motion history for SOS detection
    const countHistoryPerHand = [];
    const motionHistories = []; // array of arrays [{t, x}]
    const lastMotionTrigger = []; // timestamps per hand to avoid spam

    // helper math
    const vec = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
    const dot = (u, v) => u.x * v.x + u.y * v.y;
    const mag = (v) => Math.hypot(v.x, v.y) || 1e-9;

    // finger detection: return number of extended fingers
    // `th` is the current threshold set (defaults, or whatever calibration produced)
    function detectExtendedFingers(landmarks, th) {
        // palm center (average of wrist and some MCPs)
        const palmIdx = [0, 1, 5, 9, 13, 17];
        let px = 0, py = 0;
        for (const i of palmIdx) { px += landmarks[i].x; py += landmarks[i].y; }
        px /= palmIdx.length; py /= palmIdx.length;
        const palm = { x: px, y: py };

        const tips = [4, 8, 12, 16, 20];
        const mcp = [2, 5, 9, 13, 17]; // thumb uses 2 as base
        let count = 0;

        for (let i = 0; i < tips.length; i++) {
            const tip = landmarks[tips[i]];
            const pip = landmarks[tips[i] - 2] || landmarks[1];
            const base = landmarks[mcp[i]] || landmarks[0];

            // vector from pip to tip and pip to base
            const vTip = vec(pip, tip);
            const vBase = vec(pip, base);

            // angle check: finger extended if tip and base are roughly opposite directions
            const cos = dot(vTip, vBase) / (mag(vTip) * mag(vBase));

            // distance check: tip farther from palm than pip
            const dTip = Math.hypot(tip.x - palm.x, tip.y - palm.y);
            const dPip = Math.hypot(pip.x - palm.x, pip.y - palm.y);

            let extended = false;

            // general thresholds (now calibratable — see th.*)
            if (cos < th.cosThreshold) extended = true; // fairly straight
            if (dTip > dPip * th.distRatioThreshold) extended = true; // noticeably farther from palm

            // thumb special-case: use projection across palm
            if (i === 0) {
                // axis across palm: index_mcp (5) -> pinky_mcp (17)
                const axis = vec(landmarks[17], landmarks[5]);
                const perp = { x: -axis.y / mag(axis), y: axis.x / mag(axis) };
                const wrist = landmarks[0];
                const thumbVec = { x: tip.x - wrist.x, y: tip.y - wrist.y };
                const proj = dot(thumbVec, perp);
                // thumb considered extended if it projects outward relative to palm and distance reasonable
                if (Math.abs(proj) > th.thumbProjThreshold && dTip > dPip * th.thumbDistRatioThreshold) extended = true;
                // also allow if thumb tip is far from index MCP relative to palm size
                const palmSize = Math.hypot(landmarks[9].x - wrist.x, landmarks[9].y - wrist.y) || 1e-9;
                const thumbToIndex = Math.hypot(tip.x - landmarks[5].x, tip.y - landmarks[5].y);
                if (thumbToIndex > palmSize * th.thumbIndexRatio) extended = true;
            }

            if (extended) count++;
        }

        return count;
    }

    // ---------- Calibration ----------
    // A short 2-step wizard: first show an open (5-finger) hand, then a closed fist.
    // We measure the same "cos" (angle) and "dist ratio" metrics detectExtendedFingers
    // uses, average them for each pose, and set the threshold to the midpoint between
    // the two — i.e. a real per-user calibration instead of a guess.
    const CALIB_SAMPLE_MS = 2000;
    let calibState = 'idle'; // 'idle' | 'open' | 'closed'
    let calibSamples = [];
    let calibOpenAvg = null;
    let calibStartTime = 0;

    const btnCalibrate = document.getElementById('btn_calibrate');
    const btnResetCalibration = document.getElementById('btn_reset_calibration');
    const calibStatusEl = document.getElementById('calib_status');

    function setCalibStatus(msg) { if (calibStatusEl) calibStatusEl.textContent = msg; }

    function startCalibration() {
        calibState = 'open';
        calibSamples = [];
        calibOpenAvg = null;
        calibStartTime = Date.now();
        setCalibStatus('Langkah 1/2: buka telapak tangan lebar-lebar (5 jari) di depan kamera selama 2 detik…');
    }

    // Same math as detectExtendedFingers but only for the 4 non-thumb fingers,
    // and it returns raw averages instead of a yes/no decision.
    function collectCalibSample(landmarks) {
        const palmIdx = [0, 1, 5, 9, 13, 17];
        let px = 0, py = 0;
        for (const i of palmIdx) { px += landmarks[i].x; py += landmarks[i].y; }
        px /= palmIdx.length; py /= palmIdx.length;
        const palm = { x: px, y: py };

        const tips = [8, 12, 16, 20];
        const mcp = [5, 9, 13, 17];
        let cosSum = 0, ratioSum = 0;
        for (let i = 0; i < tips.length; i++) {
            const tip = landmarks[tips[i]];
            const pip = landmarks[tips[i] - 2];
            const base = landmarks[mcp[i]];
            const vTip = vec(pip, tip);
            const vBase = vec(pip, base);
            cosSum += dot(vTip, vBase) / (mag(vTip) * mag(vBase));
            const dTip = Math.hypot(tip.x - palm.x, tip.y - palm.y);
            const dPip = Math.hypot(pip.x - palm.x, pip.y - palm.y);
            ratioSum += dTip / dPip;
        }
        return { cos: cosSum / tips.length, ratio: ratioSum / tips.length };
    }

    function averageCalibSamples() {
        const n = calibSamples.length || 1;
        return {
            cos: calibSamples.reduce((s, v) => s + v.cos, 0) / n,
            ratio: calibSamples.reduce((s, v) => s + v.ratio, 0) / n
        };
    }

    // Called once per frame (from onResults) while calibState !== 'idle'.
    function stepCalibration(firstHandLandmarks) {
        if (!firstHandLandmarks) {
            setCalibStatus('Tangan tidak terdeteksi — pastikan tangan terlihat jelas oleh kamera.');
            return;
        }
        calibSamples.push(collectCalibSample(firstHandLandmarks));
        const elapsed = Date.now() - calibStartTime;
        if (elapsed < CALIB_SAMPLE_MS || calibSamples.length < 5) return;

        if (calibState === 'open') {
            calibOpenAvg = averageCalibSamples();
            calibState = 'closed';
            calibSamples = [];
            calibStartTime = Date.now();
            setCalibStatus('Bagus! Langkah 2/2: sekarang kepalkan tangan (fist) selama 2 detik…');
            return;
        }

        if (calibState === 'closed') {
            const closedAvg = averageCalibSamples();
            const newCos = clamp((calibOpenAvg.cos + closedAvg.cos) / 2, -0.95, -0.1);
            const newRatio = clamp((calibOpenAvg.ratio + closedAvg.ratio) / 2, 1.02, 1.4);
            thresholds = { ...thresholds, cosThreshold: newCos, distRatioThreshold: newRatio };
            saveThresholds(thresholds);
            calibState = 'idle';
            setCalibStatus(`Kalibrasi tersimpan (cos=${newCos.toFixed(2)}, rasio=${newRatio.toFixed(2)}).`);
        }
    }

    if (btnCalibrate) {
        btnCalibrate.addEventListener('click', () => {
            if (!cameraRunning) { setCalibStatus('Nyalakan kamera terlebih dahulu.'); return; }
            if (calibState !== 'idle') return; // already running
            startCalibration();
        });
    }
    if (btnResetCalibration) {
        btnResetCalibration.addEventListener('click', () => {
            thresholds = { ...DEFAULT_THRESHOLDS };
            try { localStorage.removeItem(STORAGE_KEY_THRESHOLDS); } catch (e) { /* ignore */ }
            calibState = 'idle';
            setCalibStatus('Kalibrasi direset ke default.');
        });
    }

    // ---------- SOS sensitivity slider ----------
    const sensitivitySlider = document.getElementById('sos_sensitivity');
    const sensitivityValueEl = document.getElementById('sos_sensitivity_value');
    if (sensitivitySlider) {
        sensitivitySlider.value = String(sosSensitivity);
        if (sensitivityValueEl) sensitivityValueEl.textContent = String(sosSensitivity);
        sensitivitySlider.addEventListener('input', () => {
            sosSensitivity = Number(sensitivitySlider.value);
            motionParams = motionParamsFromSensitivity(sosSensitivity);
            if (sensitivityValueEl) sensitivityValueEl.textContent = String(sosSensitivity);
            saveSensitivity(sosSensitivity);
        });
    }

    function onResults(results) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (!results || !results.image) { canvasCtx.restore(); return; }

        // Mirror effect: flip horizontally so it behaves like a selfie camera.
        // Everything drawn after this (video frame, landmarks, pointer) is mirrored
        // together, and is undone by the canvasCtx.restore() below.
        canvasCtx.translate(canvasElement.width, 0);
        canvasCtx.scale(-1, 1);

        canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

        let displayCount = 0;
        // raw positions to be used after restoring transform (use first hand if present)
        let rawWristX = null;
        let rawWristY = null;
        let countText = '';
        let firstHandLandmarks = null;

        if (results.multiHandLandmarks && results.multiHandLandmarks.length) {
            const allHands = results.multiHandLandmarks;
            const numHands = allHands.length;
            let totalFingers = 0;
            firstHandLandmarks = allHands[0];

            // ensure helper arrays sized (grow or shrink to match current hand count)
            while (countHistoryPerHand.length < numHands) countHistoryPerHand.push([]);
            while (motionHistories.length < numHands) motionHistories.push([]);
            while (lastMotionTrigger.length < numHands) lastMotionTrigger.push(0);
            countHistoryPerHand.length = numHands;
            motionHistories.length = numHands;
            lastMotionTrigger.length = numHands;

            for (let h = 0; h < allHands.length; h++) {
                const landmarks = allHands[h];

                // draw per-hand
                if (typeof drawConnectors === 'function' && typeof HAND_CONNECTIONS !== 'undefined') {
                    drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00F6FF', lineWidth: 4 });
                }
                if (typeof drawLandmarks === 'function') {
                    drawLandmarks(canvasCtx, landmarks, { color: '#FF0055', lineWidth: 2, radius: 5 });
                }

                // detect fingers for this hand (using current, possibly calibrated, thresholds)
                const countNow = detectExtendedFingers(landmarks, thresholds);

                // per-hand smoothing
                const hist = countHistoryPerHand[h];
                hist.push(countNow);
                if (hist.length > HISTORY_SIZE) hist.shift();
                const freq = {};
                for (const c of hist) freq[c] = (freq[c] || 0) + 1;
                let best = hist[hist.length - 1];
                let bestScore = 0;
                for (const k in freq) {
                    if (freq[k] > bestScore) { bestScore = freq[k]; best = Number(k); }
                }
                totalFingers += best;

                // draw pointer for this hand's index tip
                const it = landmarks[8];
                const rawPx = it.x * canvasElement.width;
                const rawPy = it.y * canvasElement.height;
                canvasCtx.beginPath();
                canvasCtx.arc(rawPx, rawPy, 10, 0, 2 * Math.PI);
                canvasCtx.fillStyle = 'rgba(255,255,0,0.5)';
                canvasCtx.fill();
                canvasCtx.stroke();

                // motion history (use index tip x) — skip SOS logic while calibrating,
                // so moving into position for calibration doesn't trigger a false SOS.
                const now = Date.now();
                const mHist = motionHistories[h];
                mHist.push({ t: now, x: it.x });
                while (mHist.length && (now - mHist[0].t) > MOTION_WINDOW_MS) mHist.shift();
                let dirChanges = 0;
                for (let i = 1; i < mHist.length; i++) {
                    const prev = mHist[i - 1].x;
                    const cur = mHist[i].x;
                    if ((cur - prev) === 0) continue;
                    const signPrev = Math.sign(prev - (mHist[i - 2]?.x ?? prev));
                    const signCur = Math.sign(cur - prev);
                    if (i >= 2 && signCur !== 0 && signPrev !== 0 && signCur !== signPrev) dirChanges++;
                }
                const xs = mHist.map(o => o.x);
                const amp = xs.length ? (Math.max(...xs) - Math.min(...xs)) : 0;
                if (
                    calibState === 'idle' &&
                    dirChanges >= motionParams.dirChanges &&
                    amp > motionParams.amplitude &&
                    (now - lastMotionTrigger[h] > motionParams.cooldownMs)
                ) {
                    sosTriggered(h);
                    lastMotionTrigger[h] = now;
                }

                // set raw wrist from first hand for overlay anchor
                if (h === 0) {
                    rawWristX = landmarks[0].x * canvasElement.width;
                    rawWristY = landmarks[0].y * canvasElement.height;
                }
            }

            displayCount = totalFingers;
            countText = `Total Jari: ${displayCount} (Hands: ${numHands})`;
        }

        // restore to normal (non-mirrored) coordinate system before drawing text
        canvasCtx.restore();

        // advance the calibration wizard, if it's running
        if (calibState !== 'idle') stepCalibration(firstHandLandmarks);

        // draw info box and text using a DOM overlay (not mirrored) for correct text orientation
        const wristX = (rawWristX != null) ? (canvasElement.width - rawWristX) : canvasElement.width / 2;
        const wristY = (rawWristY != null) ? rawWristY : canvasElement.height - 60;

        let countBox = document.getElementById('count_box');
        if (!countBox) {
            countBox = document.createElement('div');
            countBox.id = 'count_box';
            countBox.className = 'count-box';
            // always append to body to avoid inheriting transforms from container/video
            document.body.appendChild(countBox);
        }
        countBox.textContent = countText;
        const rect = canvasElement.getBoundingClientRect();
        countBox.style.left = `${rect.left + wristX}px`;
        countBox.style.top = `${rect.top + wristY + 8}px`;

        // update status element
        const statusEl = document.getElementById('camera_status');
        if (statusEl) statusEl.textContent = `Status: ${displayCount ? 'Running' : 'Idle'}`;
    }

    // init MediaPipe Hands
    let hands = null;
    if (typeof Hands === 'undefined') {
        showError('Library MediaPipe tidak ditemukan. Pastikan CDN tersedia.');
    } else {
        hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
        hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
        hands.onResults(onResults);
    }

    // camera wrapper
    if (typeof Camera === 'undefined' && hands) {
        showError('MediaPipe Camera tidak ditemukan.');
    }
    function createCamera() {
        if (typeof Camera === 'undefined' || !hands) return null;
        return new Camera(videoElement, {
            onFrame: async () => { try { await hands.send({ image: videoElement }); } catch (e) { console.error(e); } },
            width: 640, height: 480
        });
    }

    const btnToggleCamera = document.getElementById('btn_toggle_camera');
    function updateToggleButton() {
        if (btnToggleCamera) btnToggleCamera.textContent = cameraRunning ? 'Hentikan Kamera' : 'Mulai Kamera';
    }
    updateToggleButton();

    // Stops the actual MediaStream tracks so the browser's camera indicator turns off —
    // camera.stop() (if it even exists on this build of the library) only stops the
    // frame loop, it doesn't release the hardware.
    function stopCameraTracks() {
        const stream = videoElement.srcObject;
        if (stream && typeof stream.getTracks === 'function') {
            stream.getTracks().forEach((track) => track.stop());
        }
        videoElement.srcObject = null;
    }

    function stopCameraFully() {
        if (camera && typeof camera.stop === 'function') {
            try { camera.stop(); } catch (e) { console.warn(e); }
        }
        stopCameraTracks();
        camera = null; // force a fresh Camera instance (and a fresh permission prompt) next start
        cameraRunning = false;
        calibState = 'idle';
        updateToggleButton();
        const statusEl = document.getElementById('camera_status');
        if (statusEl) statusEl.textContent = 'Status: Dihentikan';
        // clear the overlay so stale detections don't linger on screen
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    }

    async function startCamera() {
        if (!hands) { showError('Hands library belum siap'); return; }
        if (!camera) camera = createCamera();
        if (!camera) { showError('Tidak dapat membuat instance Camera'); return; }
        try {
            await camera.start();
            hideError();
            cameraRunning = true;
            updateToggleButton();
        } catch (err) {
            console.error(err);
            showError('Gagal akses kamera');
        }
    }

    if (btnToggleCamera) {
        btnToggleCamera.addEventListener('click', () => {
            if (cameraRunning) stopCameraFully();
            else startCamera();
        });
    }

    startCamera();
});