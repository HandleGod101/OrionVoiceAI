const $ = (id) => document.getElementById(id);

let pc = null;
let dc = null;
let stream = null;
let timer = null;
let started = null;
let muted = false;

// Ephemeral transcript, kept only in this browser tab until a new call/refresh.
let evaluationTurns = [];
let transcriptIncomplete = false;
let finalizedCall = null;
let activeScenarioId = null;
let evaluationBusy = false;
let resolvedVariation = {};
let callStartedAt = null;
let callEndedAt = null;
function resetEvaluation() {
    evaluationTurns = []; transcriptIncomplete = false;
    finalizedCall = null; activeScenarioId = null; callStartedAt = null; callEndedAt = null;
    $("resultsHint").textContent = "";
    $("seeResultsBtn").classList.add("hidden");
    $("resultsPanel").classList.add("hidden");
    $("resultsContent").hidden = false;
    $("evaluationToggleBtn").setAttribute("aria-expanded", "true");
    $("evaluationToggleBtn").setAttribute("aria-label", "Collapse call evaluation");
    $("resultsContent").replaceChildren();
}

let consumerName = "Consumer";

let scenarios = [];
let opts = {};
let activeCallId = 0;
let callDirection = "outbound";
let callPhase = "idle";
let ringingInterval = null;
let ringTimeout = null;
let ringAudioContext = null;
let pendingCall = false;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function stopRinging() {
    if (ringingInterval) clearInterval(ringingInterval);
    ringingInterval = null;
    if (ringTimeout) clearTimeout(ringTimeout);
    ringTimeout = null;
    if (ringAudioContext) { ringAudioContext.close().catch(() => {}); ringAudioContext = null; }
}
function ringTone() {
    try {
        if (!ringAudioContext) ringAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = ringAudioContext;
        const now = ctx.currentTime;
        for (const freq of [440, 480]) {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = "sine"; osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.045, now + 0.025);
            gain.gain.setValueAtTime(0.045, now + 1.95);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now); osc.stop(now + 2.01);
        }
    } catch (err) { log("Ringtone unavailable: " + err.message); }
}
function showCallPhase(message, phase) {
    callPhase = phase;
    $("callPhase").textContent = message;
    $("callPhase").classList.toggle("hidden", phase === "idle");
}
function updateMicrophone() {
    const enabled = !muted && callPhase === "live" && !evaluationBusy;
    stream?.getAudioTracks().forEach(track => { track.enabled = enabled; });
    $("micState").textContent = enabled ? "On" : muted ? "Muted" : "Waiting…";
}
async function connectCall(callId) {
    if (callId !== activeCallId || !pendingCall) return;
    pendingCall = false;
    stopRinging();
    showCallPhase("Connecting to GPT-Live…", "connecting");
    try { await connectLive(callId); }
    catch (err) {
        if (callId !== activeCallId) return;
        error(err.message);
        end(true);
    }
}

function beginRinging(callId) {
    if (callId !== activeCallId) return;
    if (callDirection === "inbound") {
        showCallPhase("Incoming call — answer within 15 seconds", "ringing");
        status("Incoming call", "connecting");
        $("answerBtn").classList.remove("hidden");
        ringTone();
        ringingInterval = setInterval(ringTone, 6000);
        ringTimeout = setTimeout(() => {
            if (callId !== activeCallId || !pendingCall) return;
            end(true);
            showCallPhase("Missed call — no connection established", "missed");
            status("Missed call", "idle");
        }, 15000);
    } else {
        showCallPhase("Dialing…", "dialing");
        status("Dialing", "connecting");
        ringTone();
        ringTimeout = setTimeout(() => {
            if (callId !== activeCallId || !pendingCall) return;
            stopRinging();
            showCallPhase("Ringing — waiting for consumer…", "ringing");
            ringTimeout = setTimeout(() => connectCall(callId), 500 + Math.random() * 1000);
        }, 2000);
    }
}



function log(message, data = null) {
    const text =
        `[${new Date().toLocaleTimeString()}] ${message}` +
        (data ? `\n${JSON.stringify(data, null, 2)}` : "");

    console.log(message, data ?? "");

    $("debug").textContent += "\n" + text;
    $("debug").scrollTop = $("debug").scrollHeight;
}


function error(message) {
    $("errorBox").textContent = message;
    $("errorBox").classList.remove("hidden");

    log("ERROR: " + message);
}


function clearError() {
    $("errorBox").classList.add("hidden");
}


function status(text, state = "idle") {
    $("statusText").textContent = text;
    $("statusPill").className = `pill ${state}`;
}


function title(text) {
    return text
        .replaceAll("_", " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function displayLabel(key) {
    return title(key).replace(/\bDob\b/g, "Date of Birth");
}

function displayValue(key, value) {
    if (typeof value === "boolean") {
        return value ? "Yes" : "No";
    }
    if (typeof value === "number" && /balance|payment|amount/i.test(key)) {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD"
        }).format(value);
    }
    return String(value);
}


async function setup() {
    const [scenarioResponse, optionsResponse] = await Promise.all([
        fetch("/api/scenarios", { cache: "no-store" }),
        fetch("/api/options", { cache: "no-store" })
    ]);

    scenarios = await scenarioResponse.json();
    opts = await optionsResponse.json();

    // Populate scenario dropdown
    $("scenario").innerHTML = scenarios
        .map(
            (scenario) =>
                `<option value="${escapeHtml(scenario.id)}">
                    ${escapeHtml(scenario.name)}
                </option>`
        )
        .join("");

    renderAccountDebrief();
    await loadScenarioOptions();
    health();
}


function renderAccountDebrief() {
    const scenario = scenarios.find(
        (scenario) => scenario.id === $("scenario").value
    );

    if (!scenario) {
        $("accountDebrief").textContent = "";
        return;
    }

    const consumer = scenario.consumer || {};
    const account = scenario.account || {};
    const profileRows = Object.entries(consumer)
        .map(([key, value]) => `
            <div class="accountField">
                <dt>${escapeHtml(displayLabel(key))}</dt>
                <dd>${escapeHtml(displayValue(key, value))}</dd>
            </div>
        `)
        .join("");
    const accountRows = Object.entries(account)
        .map(([key, value]) => `
            <div class="accountField">
                <dt>${escapeHtml(displayLabel(key))}</dt>
                <dd>${escapeHtml(displayValue(key, value))}</dd>
            </div>
        `)
        .join("");

    $("accountDebrief").innerHTML = `
        <section class="accountPreview" aria-label="Fictional collector account preview">
            <div class="accountPreviewHeader">
                <div>
                    <h3>Account preview for collector</h3>
                </div>
                <span class="accountBadge">Reference during call</span>
            </div>
            <div class="accountSections">
                <section>
                    <h4>Consumer profile</h4>
                    <dl class="accountFields">${profileRows || "<dt>Profile</dt><dd>Not provided</dd>"}</dl>
                </section>
                <section>
                    <h4>Account details</h4>
                    <dl class="accountFields">${accountRows || "<dt>Account</dt><dd>Not provided</dd>"}</dl>
                </section>
            </div>
        </section>
    `;
}


async function loadScenarioOptions() {
    const scenarioId = $("scenario").value;

    const response = await fetch(
        `/api/scenarios/${encodeURIComponent(scenarioId)}/options`,
        { cache: "no-store" }
    );

    if (!response.ok) {
        throw Error(
            `Could not load scenario options: ${response.status}`
        );
    }

    const scenarioOptions = await response.json();

    for (const [key, config] of Object.entries(scenarioOptions)) {
        const select = $(key);

        // Some scenario fields may exist only on the backend and intentionally
        // have no visible control in index.html.
        //
        // Do NOT crash if the backend returns one of those fields.
        // The backend will resolve that value when the call starts.
        if (!select) {
            log(
                `No visible control for scenario option "${key}"; ` +
                `backend will resolve it.`
            );
            continue;
        }

        const values = config.values || [];

        const valueOptions = values
            .map(
                (value) =>
                    `<option value="${value}">
                        ${title(value)}
                    </option>`
            )
            .join("");

        if (config.locked) {
            select.innerHTML = valueOptions;
            select.value = config.locked_value;
            select.disabled = true;
            select.dataset.scenarioLocked = "true";
        } else {
            select.innerHTML =
                `<option value="random">🎲 Random</option>` +
                valueOptions;

            select.value = "random";
            select.disabled = false;
            select.dataset.scenarioLocked = "false";
        }
    }

    log(
        "Scenario-specific options loaded.",
        scenarioOptions
    );
}


function body() {
    return {
        scenario_id: $("scenario").value,

        // Only include controls that actually exist in the page.
        // Backend-only options are intentionally omitted and will
        // be resolved server-side.
        call_type: $("callDirection").value,
        ...Object.fromEntries(
            Object.keys(opts)
                .filter((key) => $(key))
                .map((key) => [
                    key,
                    $(key).value
                ])
        )
    };
}


function lock(locked) {
    const controls = [
        "callDirection",
        "scenario",
        ...Object.keys(opts),
        "randomizeBtn"
    ];

    controls.forEach((key) => {
        const element = $(key);

        if (!element) {
            return;
        }

        const scenarioLocked =
            element.dataset.scenarioLocked === "true";

        element.disabled =
            locked || scenarioLocked;
    });
}


function turn(who, text, kind) {
    if (!text?.trim()) {
        return;
    }

    // Remove placeholder text
    $("transcript")
        .querySelector(".empty")
        ?.remove();

    const wrapper =
        document.createElement("div");

    const speaker =
        document.createElement("div");

    const bubble =
        document.createElement("div");

    wrapper.className =
        `turn ${kind}`;

    speaker.className =
        "who";

    bubble.className =
        "bubble";

    speaker.textContent =
        who;

    bubble.textContent =
        text.trim();

    wrapper.append(
        speaker,
        bubble
    );

    $("transcript").append(
        wrapper
    );

    $("transcript").scrollTop =
        $("transcript").scrollHeight;
}


function tick() {
    if (!started) {
        return;
    }

    const seconds =
        Math.floor(
            (Date.now() - started) / 1000
        );

    const minutes =
        Math.floor(seconds / 60);

    const remainingSeconds =
        seconds % 60;

    $("timer").textContent =
        `${String(minutes).padStart(2, "0")}:` +
        `${String(remainingSeconds).padStart(2, "0")}`;
}


let liveFragments = [];
let liveEventIds = new Set();
let liveClosed = false;
let liveCloseResolve = null;
let liveStartTimeout = null;
let transcriptClearSequence = 0;
let liveRequest = null;

async function waitForIce(connection) {
    if (connection.iceGatheringState === "complete") return;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error("ICE gathering timed out")); }, 12000);
        function cleanup() { clearTimeout(timeout); connection.removeEventListener("icegatheringstatechange", check); }
        function check() {
            if (connection.iceGatheringState === "complete") { cleanup(); resolve(); }
        }
        connection.addEventListener("icegatheringstatechange", check);
        check();
    });
}

async function start() {
    if (evaluationBusy) return;
    end(false);
    resetEvaluation();
    clearError();
    liveFragments = []; liveEventIds.clear(); liveClosed = false;
    transcriptClearSequence = 0;
    callDirection = $("callDirection").value;
    activeScenarioId = $("scenario").value;
    consumerName = scenarios.find(s => s.id === activeScenarioId)?.consumer?.name?.split(/\s+/)[0] || "Consumer";
    pendingCall = true;
    const callId = ++activeCallId;
    $("transcript").innerHTML = '<div class="empty">Conversation appears here.</div>';
    $("timer").textContent = "00:00";
    $("startBtn").disabled = true;
    $("endBtn").disabled = false;
    lock(true);
    status("Preparing call", "connecting");
    showCallPhase("Requesting microphone…", "connecting");
    try {
        const acquired = await navigator.mediaDevices.getUserMedia({audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true
        }});
        if (callId !== activeCallId) { acquired.getTracks().forEach(t => t.stop()); return; }
        stream = acquired;
        stream.getAudioTracks().forEach(t => { t.enabled = false; });
        beginRinging(callId);
    } catch (err) {
        if (callId !== activeCallId) return;
        error(err.message); end(true);
    }
}

async function connectLive(callId) {
    const connection = pc = new RTCPeerConnection();
    const current = () => callId === activeCallId && pc === connection;
    connection.ontrack = event => {
        if (!current()) return;
        $("remoteAudio").srcObject = event.streams[0];
        $("remoteAudio").play().catch(err => log("Audio playback: " + err.message));
    };
    connection.onconnectionstatechange = () => {
        if (!current()) return;
        log("Voice connection: " + connection.connectionState);
        if (connection.connectionState === "failed") {
            transcriptIncomplete = true;
            error("Voice connection failed.");
            finishAndPrepareResults();
        }
    };
    stream.getTracks().forEach(track => connection.addTrack(track, stream));
    const channel = dc = connection.createDataChannel("oai-events");
    channel.onmessage = event => {
        if (!current()) return;
        try { events(JSON.parse(event.data)); }
        catch (err) { transcriptIncomplete = true; log("Live event error: " + err.message); }
    };
    channel.onerror = () => { if (current()) error("Voice data channel error."); };
    channel.onclose = () => {
        if (!current() || liveClosed) return;
        transcriptIncomplete = true;
        liveCloseResolve?.();
        if (!evaluationBusy) finishAndPrepareResults();
    };
    const offer = await connection.createOffer();
    if (!current()) return;
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    if (!current()) return;
    const controller = liveRequest = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    let data;
    try {
        const response = await fetch("/api/session", {
            method: "POST", headers: {"Content-Type": "application/json"},
            signal: controller.signal,
            body: JSON.stringify({...body(), sdp: connection.localDescription.sdp})
        });
        data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data));
    } finally { clearTimeout(timeout); if (liveRequest === controller) liveRequest = null; }
    if (!current()) return;
    resolvedVariation = data.variation || {};
    activeScenarioId = data.scenario.id;
    consumerName = data.scenario.consumer_name?.trim().split(/\s+/)[0] || "Consumer";
    $("activeConfig").textContent = `${data.scenario.name} • ${Object.values(resolvedVariation).map(title).join(" • ")}`;
    log("GPT-Live session created", {model: data.model, session_id: data.session_id});
    liveStartTimeout = setTimeout(() => {
        if (current() && callPhase !== "live") { error("GPT-Live did not start in time."); end(true); }
    }, 20000);
    await connection.setRemoteDescription({type: "answer", sdp: data.sdp});
}

function groupLiveFragments(fragments) {
    const groups = [];
    const lastBySpeaker = new Map();
    for (const fragment of [...fragments].sort((a,b) => a.start-b.start || a.sequence-b.sequence)) {
        const last = lastBySpeaker.get(fragment.speaker);
        if (last && fragment.start <= last.end + 1500 && last.text.length + fragment.text.length <= 3500) {
            last.text += fragment.text;
            last.end = Math.max(last.end, fragment.end);
        } else {
            const group = {...fragment}; groups.push(group); lastBySpeaker.set(fragment.speaker, group);
        }
    }
    return groups;
}
function captureLiveTranscript(message, speaker) {
    if (!message.delta) return;
    if (message.event_id && liveEventIds.has(message.event_id)) return;
    if (message.event_id) liveEventIds.add(message.event_id);
    const start = Number.isFinite(message.start_ms) ? message.start_ms : Math.max(0, Date.now() - (callStartedAt || Date.now()));
    const endTime = Number.isFinite(message.end_ms) ? Math.max(start, message.end_ms) : start;
    liveFragments.push({speaker, text: message.delta, start, end: endTime, sequence: liveFragments.length + 1});
    evaluationTurns = groupLiveFragments(liveFragments).filter(t => t.text.trim()).map((t,i) => ({
        id: `turn-${i+1}`, speaker: t.speaker, text: t.text.trim(), timestamp_ms: Math.round(t.start)
    }));
    $("transcript").replaceChildren();
    for (const t of groupLiveFragments(liveFragments.filter(t => t.sequence > transcriptClearSequence))) {
        turn(t.speaker === "agent" ? "YOU / AGENT" : consumerName, t.text, t.speaker === "agent" ? "user" : "ai");
    }
}
function events(message) {
    if (message.type === "session.started") {
        if (started || liveClosed) return;
        clearTimeout(liveStartTimeout); liveStartTimeout = null;
        started = callStartedAt = Date.now();
        showCallPhase("Connected — consumer answering…", "live");
        status("Live", "live");
        $("aiState").textContent = "Connected";
        $("muteBtn").disabled = false;
        timer = setInterval(tick, 1000);
        updateMicrophone();
        dc.send(JSON.stringify({type: "session.commentary.append", event_id: `greeting_${activeCallId}`,
            delegation_id: null, content: "Begin now in English with only a short natural hello, then pause and listen to the collector. Do not volunteer account details in the greeting."}));
    } else if (message.type === "session.input_transcript.delta") {
        captureLiveTranscript(message, "agent");
    } else if (message.type === "session.output_transcript.delta") {
        captureLiveTranscript(message, "consumer");
    } else if (message.type === "session.closed") {
        liveClosed = true;
        log("GPT-Live closed", {reason: message.reason, usage: message.usage});
        liveCloseResolve?.();
        if (!evaluationBusy) finishAndPrepareResults();
    } else if (message.type === "error" || message.type === "session.error") {
        transcriptIncomplete = true;
        error(message.error?.message || JSON.stringify(message.error || message));
    }
}

function end(reset = true) {
    clearTimeout(liveStartTimeout); liveStartTimeout = null;
    liveRequest?.abort(); liveRequest = null;
    liveCloseResolve?.(); liveCloseResolve = null;
    if (!liveClosed && dc?.readyState === "open") {
        try { dc.send(JSON.stringify({type: "session.close"})); } catch {}
    }
    stopRinging();
    pendingCall = false;
    $("answerBtn").classList.add("hidden");
    showCallPhase("", "idle");

    // --------------------------------------------------
    // Stop timer
    // --------------------------------------------------

    if (timer) {
        clearInterval(
            timer
        );
    }

    timer = null;
    started = null;


    // --------------------------------------------------
    // Remove data channel callbacks before closing
    // --------------------------------------------------

    try {

        if (dc) {
            dc.onopen = null;
            dc.onmessage = null;
            dc.onerror = null;
            dc.onclose = null;
            dc.onclose = null;

            dc.close();
        }

    } catch {}


    // --------------------------------------------------
    // Remove WebRTC callbacks and close connection
    // --------------------------------------------------

    try {

        if (pc) {
            pc.ontrack = null;
            pc.onconnectionstatechange = null;

            pc.close();
        }

    } catch {}


    // --------------------------------------------------
    // STOP MICROPHONE COMPLETELY
    // --------------------------------------------------

    try {

        stream
            ?.getTracks()
            .forEach(
                (track) =>
                    track.stop()
            );

    } catch {}


    // --------------------------------------------------
    // DETACH PREVIOUS AI AUDIO
    // --------------------------------------------------

    try {

        $("remoteAudio").pause();

        $("remoteAudio").srcObject =
            null;

    } catch {}


    // --------------------------------------------------
    // DESTROY ALL CURRENT CALL REFERENCES
    // --------------------------------------------------

    pc = null;
    dc = null;
    stream = null;

    muted = false;




    // --------------------------------------------------
    // Invalidate all callbacks belonging to the
    // call that just ended.
    //
    // When start() calls end(false), start() itself
    // immediately creates a new call ID afterward.
    // --------------------------------------------------

    if (reset) {
        activeCallId += 1;
    }


    // --------------------------------------------------
    // RESET UI
    // --------------------------------------------------

    $("startBtn").disabled =
        false;

    $("endBtn").disabled =
        true;

    $("muteBtn").disabled =
        true;


    $("muteBtn").textContent =
        "Mute";


    lock(false);


    $("micState").textContent =
        "Off";


    $("aiState").textContent =
        "Disconnected";


    if (reset) {

        status(
            "Call ended",
            "idle"
        );
    }


    log(
        "Call closed."
    );
}



// Freeze the microphone and wait for Live to drain transcripts before evaluation.
async function finishAndPrepareResults() {
    if (evaluationBusy) return;
    if (!started) { end(true); return; }
    evaluationBusy = true;
    $("endBtn").disabled = true;
    stream?.getAudioTracks().forEach(t => { t.enabled = false; });
    $("resultsHint").textContent = "Finalizing transcript…";
    if (!liveClosed && dc?.readyState === "open") {
        await new Promise(resolve => {
            const timeout = setTimeout(() => { transcriptIncomplete = true; done(); }, 15000);
            function done() { clearTimeout(timeout); liveCloseResolve = null; resolve(); }
            liveCloseResolve = done;
            try { dc.send(JSON.stringify({type: "session.close"})); }
            catch { transcriptIncomplete = true; done(); }
        });
    } else if (!liveClosed) {
        transcriptIncomplete = true;
    }
    callEndedAt = Date.now();
    finalizedCall = {
        scenario_id: activeScenarioId,
        turns: evaluationTurns.map(({id,speaker,text,timestamp_ms}) => ({id,speaker,text,timestamp_ms}))
            .sort((a,b) => a.timestamp_ms-b.timestamp_ms || Number(a.id.split("-")[1])-Number(b.id.split("-")[1])),
        metadata: {call_type: callDirection, communication: resolvedVariation.communication,
            difficulty: resolvedVariation.difficulty, duration_ms: callEndedAt - callStartedAt},
        transcript_quality: {incomplete: transcriptIncomplete, finalization_confirmed: liveClosed,
            note: "GPT-Live timestamped transcript fragments grouped for evaluation; not independently verified against audio."}
    };
    end(true);
    if (activeScenarioId !== "failed_payment_arrangement") {
        $("resultsHint").textContent = "Call ended. Evaluation is currently available only for Rachel Carter.";
        evaluationBusy = false;
        return;
    }
    $("seeResultsBtn").classList.remove("hidden");
    $("resultsHint").textContent = transcriptIncomplete
        ? "Call ended. Some speech may be missing; the evaluator will flag uncertainty."
        : "Call ended. Results are available until you start another call or refresh.";
    evaluationBusy = false;
}
function renderResults(data) {
    const root = $("resultsContent"); root.replaceChildren();
    const heading = (text) => {const h=document.createElement("h3");h.textContent=text;root.append(h);};
    const line = (label, status, reason, evidence, score) => {
        const statusClass = score == null
            ? status
            : score >= 4 ? "pass" : score <= 1 ? "fail" : "needs_review";
        const article=document.createElement("article");article.className=`evaluationItem evaluationItem--${statusClass}`;
        const header=document.createElement("div");header.className="evaluationItemHeader";
        const title=document.createElement("strong");title.textContent=label;
        const tag=document.createElement("span");tag.className="evaluationStatus " + statusClass;
        tag.textContent=score == null ? status.replaceAll("_", " ") : `${score}/5`;
        header.append(title,tag);article.append(header);
        const detail=document.createElement("p");detail.textContent=reason;article.append(detail);
        (evidence||[]).forEach(ev => {const quote=document.createElement("blockquote");
            quote.textContent=`${ev.turn_id}: “${ev.quote}”`;article.append(quote);});root.append(article);
    };
    heading("Compliance — evidence-based checks");
    for (const [key,item] of Object.entries(data.compliance || {})) line(key.replaceAll("_"," "),item.status,item.reason,item.evidence);
    heading("Call performance");
    for (const [key,item] of Object.entries(data.performance || {})) line(key.replaceAll("_"," "),item.status,item.reason,item.evidence,item.score);
    if (data.overall_summary) {
        const summary=document.createElement("section");summary.className="evaluationSummary";
        const summaryHeading=document.createElement("h3");summaryHeading.textContent="Coaching summary";
        const summaryText=document.createElement("p");summaryText.textContent=data.overall_summary;
        summary.append(summaryHeading,summaryText);root.append(summary);
    }
    for (const [label,items] of [["Strengths",data.strengths],["Improvements",data.improvements]]) {
        if (!items?.length) continue;
        const section=document.createElement("section");section.className=`evaluationNotes evaluationNotes--${label.toLowerCase()}`;
        const h=document.createElement("h3");h.textContent=label;section.append(h);
        const ul=document.createElement("ul");items.forEach(v=>{const li=document.createElement("li");li.textContent=v;ul.append(li);});
        section.append(ul);root.append(section);
    }
}
async function seeResults() {
    if (!finalizedCall || evaluationBusy) return;
    if (!finalizedCall.turns.some(t=>t.speaker==="agent")) {
        $("resultsHint").textContent="No collector transcript was captured. Evaluation cannot proceed.";return;
    }
    evaluationBusy=true;
    $("startBtn").disabled=true;
    $("seeResultsBtn").disabled=true;
    $("resultsPanel").classList.remove("hidden");
    $("resultsContent").hidden=false;
    $("evaluationToggleBtn").setAttribute("aria-expanded", "true");
    $("evaluationToggleBtn").setAttribute("aria-label", "Collapse call evaluation");
    $("resultsContent").textContent="Evaluating this call…";
    try {
        const res=await fetch("/api/evaluate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(finalizedCall)});
        if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail||`HTTP ${res.status}`);
        renderResults(await res.json());
        $("resultsHint").textContent="";
    } catch(e) {
        $("resultsContent").textContent="Evaluation failed: "+e.message+". You can retry while this page remains open.";
    } finally {evaluationBusy=false;$("seeResultsBtn").disabled=false;$("startBtn").disabled=false;}
}

function toggleEvaluation() {
    const expanded = $("evaluationToggleBtn").getAttribute("aria-expanded") === "true";
    $("resultsContent").hidden = expanded;
    $("evaluationToggleBtn").setAttribute("aria-expanded", String(!expanded));
    $("evaluationToggleBtn").setAttribute(
        "aria-label",
        expanded ? "Expand call evaluation" : "Collapse call evaluation"
    );
}

// --------------------------------------------------
// MUTE
// --------------------------------------------------

function mute() {

    muted =
        !muted;

    updateMicrophone();


    $("muteBtn").textContent =
        muted
            ? "Unmute"
            : "Mute";


    $("micState").textContent =
        muted
            ? "Muted"
            : "On";
}


// --------------------------------------------------
// BACKEND HEALTH
// --------------------------------------------------

async function health() {

    try {

        const response =
            await fetch(
                "/api/health",
                {
                    cache:
                        "no-store",

                    headers: {
                        "Cache-Control":
                            "no-cache, no-store, must-revalidate",

                        "Pragma":
                            "no-cache"
                    }
                }
            );


        const data =
            await response.json();


        log(
            "Backend health.",
            data
        );


        if (
            !data.api_key_configured
        ) {

            error(
                "OPENAI_API_KEY is not configured in .env."
            );
        }


    } catch (err) {

        error(
            err.message
        );
    }
}


// --------------------------------------------------
// UI EVENT LISTENERS
// --------------------------------------------------

$("scenario").onchange =
    async () => {

        renderAccountDebrief();
        clearError();

        try {

            await loadScenarioOptions();

        } catch (err) {

            error(
                err.message
            );
        }
    };


$("randomizeBtn").onclick =
    () => {

        Object
            .keys(opts)
            .forEach(
                (key) => {

                    const element =
                        $(key);


                    // Ignore backend-only options that do
                    // not have a visible select.

                    if (!element) {
                        return;
                    }


                    if (
                        element.dataset
                            .scenarioLocked !==
                            "true" &&

                        [
                            ...element.options
                        ].some(
                            (option) =>
                                option.value ===
                                "random"
                        )
                    ) {

                        element.value =
                            "random";
                    }
                }
            );


        log(
            "All unlocked controls set to Random."
        );
    };


$("startBtn").onclick = start;
$("answerBtn").onclick = () => {
    if (callDirection !== "inbound" || !pendingCall || callPhase !== "ringing") return;
    $("answerBtn").classList.add("hidden");
    connectCall(activeCallId);
};


$("endBtn").onclick = finishAndPrepareResults;
$("seeResultsBtn").onclick = seeResults;
$("evaluationToggleBtn").onclick = toggleEvaluation;


$("muteBtn").onclick =
    mute;


$("healthBtn").onclick =
    health;


$("copyTranscript").onclick = async () => {
    const button = $("copyTranscript");
    const text = [...$("transcript").querySelectorAll(".turn")]
        .map(turn => `${turn.querySelector(".who").textContent.trim()}:\n${turn.querySelector(".bubble").textContent.trim()}`)
        .join("\n\n");
    button.disabled = true;
    try {
        if (text) {
            await navigator.clipboard.writeText(text);
            button.textContent = "Copied!";
        } else {
            button.textContent = "Nothing to copy";
        }
    } catch {
        button.textContent = "Copy failed";
    } finally {
        setTimeout(() => {
            button.textContent = "Copy";
            button.disabled = false;
        }, 2000);
    }
};

$("clearTranscript").onclick =
    () => {
        transcriptClearSequence = liveFragments.length;

        $("transcript").innerHTML =
            '<div class="empty">' +
            'Conversation appears here.' +
            '</div>';
    };


$("copyDebug").onclick =
    () => {

        navigator.clipboard
            .writeText(
                $("debug").textContent
            );
    };


// --------------------------------------------------
// INITIALIZE APPLICATION
// --------------------------------------------------

setup()
    .catch(
        (err) => {

            error(
                err.stack ||
                err.message
            );
        }
    );
