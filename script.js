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

    // smoothing history for counts
    const HISTORY_SIZE = 6;
    const countHistory = [];

    // helper math
    const vec = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
    const dot = (u, v) => u.x * v.x + u.y * v.y;
    const mag = (v) => Math.hypot(v.x, v.y) || 1e-9;

    // finger detection: return number of extended fingers
    function detectExtendedFingers(landmarks) {
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

            // general thresholds
            if (cos < -0.55) extended = true; // fairly straight
            if (dTip > dPip * 1.12) extended = true; // noticeably farther from palm

            // thumb special-case: use projection across palm
            if (i === 0) {
                // axis across palm: index_mcp (5) -> pinky_mcp (17)
                const axis = vec(landmarks[17], landmarks[5]);
                const perp = { x: -axis.y / mag(axis), y: axis.x / mag(axis) };
                const wrist = landmarks[0];
                const thumbVec = { x: tip.x - wrist.x, y: tip.y - wrist.y };
                const proj = dot(thumbVec, perp);
                // thumb considered extended if it projects outward relative to palm and distance reasonable
                if (Math.abs(proj) > 0.03 && dTip > dPip * 0.95) extended = true;
                // also allow if thumb tip is far from index MCP relative to palm size
                const palmSize = Math.hypot(landmarks[9].x - wrist.x, landmarks[9].y - wrist.y) || 1e-9;
                const thumbToIndex = Math.hypot(tip.x - landmarks[5].x, tip.y - landmarks[5].y);
                if (thumbToIndex > palmSize * 0.55) extended = true;
            }

            if (extended) count++;
        }

        return count;
    }

    function onResults(results) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (!results || !results.image) { canvasCtx.restore(); return; }

        // draw mirrored video on canvas (so UX is natural) by transforming context
        canvasCtx.translate(canvasElement.width, 0);
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

        let displayCount = 0;

        if (results.multiHandLandmarks && results.multiHandLandmarks.length) {
            const landmarks = results.multiHandLandmarks[0];

            if (typeof drawConnectors === 'function' && typeof HAND_CONNECTIONS !== 'undefined') {
                drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00F6FF', lineWidth: 4 });
            }
            if (typeof drawLandmarks === 'function') {
                drawLandmarks(canvasCtx, landmarks, { color: '#FF0055', lineWidth: 2, radius: 5 });
            }

            const countNow = detectExtendedFingers(landmarks);

            // smoothing: push and compute mode of history
            countHistory.push(countNow);
            if (countHistory.length > HISTORY_SIZE) countHistory.shift();
            // compute frequency
            const freq = {};
            for (const c of countHistory) freq[c] = (freq[c] || 0) + 1;
            let best = countHistory[countHistory.length - 1];
            let bestScore = 0;
            for (const k in freq) {
                if (freq[k] > bestScore) { bestScore = freq[k]; best = Number(k); }
            }
            displayCount = best;

            // draw pointer at index tip
            const it = landmarks[8];
            const px = it.x * canvasElement.width;
            const py = it.y * canvasElement.height;
            canvasCtx.beginPath();
            canvasCtx.arc(px, py, 12, 0, 2 * Math.PI);
            canvasCtx.fillStyle = 'rgba(255,255,0,0.6)';
            canvasCtx.fill();
            canvasCtx.stroke();

            // draw info box near wrist (use wrist coords)
            const wristX = landmarks[0].x * canvasElement.width;
            const wristY = landmarks[0].y * canvasElement.height;
            const countText = `Total Jari: ${displayCount}`;

            canvasCtx.font = 'bold 16px Arial';
            const textWidth = canvasCtx.measureText(countText).width;
            canvasCtx.fillStyle = 'rgba(18,18,18,0.85)';
            canvasCtx.fillRect(wristX - (textWidth / 2) - 15, wristY + 15, textWidth + 30, 40);
            canvasCtx.fillStyle = '#00FFCC';
            canvasCtx.fillText(countText, wristX - (textWidth / 2), wristY + 40);
        }

        canvasCtx.restore();

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
        hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
        hands.onResults(onResults);
    }

    // camera wrapper
    let camera = null;
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

    async function startCamera() {
        if (!hands) { showError('Hands library belum siap'); return; }
        if (!camera) camera = createCamera();
        if (!camera) { showError('Tidak dapat membuat instance Camera'); return; }
        try { await camera.start(); hideError(); } catch (err) { console.error(err); showError('Gagal akses kamera'); }
    }
    startCamera();
});
