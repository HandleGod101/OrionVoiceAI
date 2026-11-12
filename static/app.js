const $ = (id) => document.getElementById(id);

let pc = null;
let dc = null;
let stream = null;
let timer = null;
let started = null;
let muted = false;

let aiText = "";
// Ephemeral transcript, kept only in this browser tab until a new call/refresh.
let evaluationTurns = [];
let transcriptSequence = 0;
let turnStartTimes = new Map();
let pendingTranscripts = new Set();
let pendingAgentSpeech = false;
let transcriptIncomplete = false;
let finalizedCall = null;
let activeScenarioId = null;
let evaluationBusy = false;
let resolvedVariation = {};
let callStartedAt = null;
let callEndedAt = null;
function recordTurn(speaker, text, itemId) {
    if (!text || !text.trim()) return;
    const existing = itemId && evaluationTurns.find(t => t.item_id === itemId && t.speaker === speaker);
    if (existing) { existing.text = text.trim(); return; }
    const stamp = itemId && turnStartTimes.has(itemId) ? turnStartTimes.get(itemId) : Date.now();
    evaluationTurns.push({id: `turn-${++transcriptSequence}`, item_id: itemId || null, speaker,
        text: text.trim(), timestamp_ms: Math.max(0, stamp - (callStartedAt || stamp))});
}
function resetEvaluation() {
    evaluationTurns = []; transcriptSequence = 0; turnStartTimes.clear();
    pendingTranscripts.clear(); pendingAgentSpeech = false; transcriptIncomplete = false;
    finalizedCall = null; activeScenarioId = null; callStartedAt = null; callEndedAt = null;
    $("resultsHint").textContent = "";
    $("seeResultsBtn").classList.add("hidden");
    $("resultsPanel").classList.add("hidden");
    $("resultsContent").hidden = false;
    $("evaluationToggleBtn").setAttribute("aria-expanded", "true");
    $("evaluationToggleBtn").setAttribute("aria-label", "Collapse call evaluation");
    $("resultsContent").replaceChildren();
}

const completedAiTranscripts = new Set();
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
let greetingCallId = null;
let greetingResponsePending = false;
let greetingResponseId = null;

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
    const enabled = !muted && !greetingResponsePending;
    stream?.getAudioTracks().forEach(track => { track.enabled = enabled; });
    $("micState").textContent = muted ? "Muted" : greetingResponsePending ? "Waiting for greeting…" : "On";
}
function greetConsumer(callId) {
    if (callId !== activeCallId || greetingCallId === callId) return;
    if (!dc || dc.readyState !== "open") {
        error("Cannot start the opening greeting because the Realtime data channel is not open.");
        updateMicrophone();
        return;
    }
    greetingCallId = callId;
    greetingResponsePending = true;
    greetingResponseId = null;
    updateMicrophone();
    try {
        dc.send(JSON.stringify({
            type: "response.create",
            response: {
                output_modalities: ["audio"],
                instructions: "The simulated telephone has just connected. You are the consumer answering or calling. Say ONLY one short, casual opening greeting, such as 'Hello?', 'Hi?', or 'Hey, hello?'. Do not give your name, account information, reason for calling, or any other details yet. Then wait for the human collector to speak."
            }
        }));
    } catch (err) {
        greetingResponsePending = false;
        updateMicrophone();
        error("Could not start the opening greeting: " + err.message);
    }
}
function connectCall(callId) {
    if (callId !== activeCallId || !pendingCall) return;
    stopRinging();
    showCallPhase("Connected — consumer answering…", "live");
    status("Live", "live");
    started = Date.now();
    callStartedAt = started;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
    $("muteBtn").disabled = false;
    pendingCall = false;
    greetConsumer(callId);
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


async function start() {
    if (evaluationBusy) return;
    clearError();

    // --------------------------------------------------
    // EVERY CALL IS INDEPENDENT
    // --------------------------------------------------
    //
    // Tear down anything that might remain from a
    // previous call BEFORE creating the new session.
    //
    // This prevents:
    // - old WebRTC connections
    // - old data channels
    // - old microphone tracks
    // - stale callbacks
    //
    // from affecting the next call.

    end(false);
    resetEvaluation();
    callDirection = $("callDirection").value;
    pendingCall = true;
    showCallPhase("Preparing " + callDirection + " call…", "connecting");

    const callId =
        ++activeCallId;

    aiText = "";
    completedAiTranscripts.clear();
    consumerName = "Consumer";
    started = null;

    $("transcript").innerHTML =
        '<div class="empty">' +
        'Conversation appears here.' +
        '</div>';

    $("timer").textContent =
        "00:00";

    $("startBtn").disabled =
        true;

    lock(true);

    status(
        "Connecting…",
        "connecting"
    );

    try {

        // --------------------------------------------------
        // 1. CREATE BRAND-NEW SCENARIO SESSION
        // --------------------------------------------------

        log(
            "1/6 Creating fresh scenario session.",
            body()
        );

        const response =
            await fetch(
                "/api/session",
                {
                    method: "POST",

                    // Never reuse an HTTP cached session response.
                    cache: "no-store",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "Cache-Control":
                            "no-cache, no-store, must-revalidate",

                        "Pragma":
                            "no-cache"
                    },

                    body:
                        JSON.stringify(
                            body()
                        )
                }
            );

        const data =
            await response.json();

        if (!response.ok) {
            throw Error(
                JSON.stringify(data)
            );
        }


        // --------------------------------------------------
        // Make sure this call wasn't replaced while the
        // request was running.
        // --------------------------------------------------

        if (callId !== activeCallId) {
            return;
        }


        // --------------------------------------------------
        // 2. READ RESOLVED SCENARIO CONFIGURATION
        // --------------------------------------------------

        resolvedVariation = data.variation || {};
        activeScenarioId = data.scenario.id;
        consumerName =
            data.scenario.consumer_name?.trim().split(/\s+/)[0] || "Consumer";


        const key =
            data.client_secret;


        log(
            "2/6 Variation resolved.",
            data.variation
        );


        $("activeConfig").textContent =
            `${data.scenario.name} • ` +
            Object
                .values(data.variation)
                .map(title)
                .join(" • ");


        // --------------------------------------------------
        // 3. REQUEST MICROPHONE
        // --------------------------------------------------

        log(
            "3/6 Requesting microphone."
        );


        stream =
            await navigator.mediaDevices
                .getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });


        stream.getAudioTracks().forEach(track => { track.enabled = false; });

        // If this is no longer the active call,
        // immediately stop the newly-created mic stream.

        if (callId !== activeCallId) {
            stream
                ?.getTracks()
                .forEach(
                    (track) =>
                        track.stop()
                );

            return;
        }


        $("micState").textContent =
            "On";


        // --------------------------------------------------
        // 4. CREATE BRAND-NEW WEBRTC CONNECTION
        // --------------------------------------------------

        pc =
            new RTCPeerConnection();

        const callPc =
            pc;


        pc.onconnectionstatechange =
            () => {

                // Ignore callbacks from an older call.
                if (
                    callId !== activeCallId ||
                    pc !== callPc
                ) {
                    return;
                }

                log(
                    "Peer: " +
                    pc.connectionState
                );
            };


        // --------------------------------------------------
        // RECEIVE AI AUDIO
        // --------------------------------------------------

        pc.ontrack =
            (event) => {

                // Ignore stale audio from an older call.
                if (
                    callId !== activeCallId ||
                    pc !== callPc
                ) {
                    return;
                }

                $("remoteAudio").srcObject =
                    event.streams[0];


                $("remoteAudio")
                    .play()
                    .catch(
                        (err) => {
                            log(
                                "Audio autoplay",
                                err.message
                            );
                        }
                    );


                log(
                    "Remote AI audio received."
                );
            };


        // --------------------------------------------------
        // SEND MICROPHONE AUDIO
        // --------------------------------------------------

        stream
            .getTracks()
            .forEach(
                (track) => {
                    pc.addTrack(
                        track,
                        stream
                    );
                }
            );


        // --------------------------------------------------
        // 5. CREATE NEW OPENAI EVENT DATA CHANNEL
        // --------------------------------------------------

        dc =
            pc.createDataChannel(
                "oai-events"
            );


        const callDc =
            dc;


        dc.onopen =
            () => {

                // Ignore callbacks from previous calls.
                if (
                    callId !== activeCallId ||
                    dc !== callDc
                ) {
                    return;
                }

                $("aiState").textContent =
                    "Connected";


                status("Ready to ring", "connecting");


                log(
                    "Data channel OPEN"
                );
            };


        dc.onmessage =
            (event) => {

                // Ignore events belonging to an old call.
                if (
                    callId !== activeCallId ||
                    dc !== callDc
                ) {
                    return;
                }

                try {
                    const message =
                        JSON.parse(
                            event.data
                        );

                    events(message);

                } catch (err) {
                    log(
                        "Could not parse OpenAI event.",
                        err.message
                    );
                }
            };


        // --------------------------------------------------
        // 6. CREATE SDP OFFER
        // --------------------------------------------------

        log(
            "4/6 Creating SDP offer."
        );


        const offer =
            await pc.createOffer();


        await pc.setLocalDescription(
            offer
        );


        // --------------------------------------------------
        // Check again for stale call
        // --------------------------------------------------

        if (
            callId !== activeCallId ||
            pc !== callPc
        ) {
            return;
        }


        // --------------------------------------------------
        // 7. EXCHANGE SDP WITH OPENAI
        // --------------------------------------------------

        log(
            "5/6 Exchanging SDP."
        );


        let sdpResponse;
        try {
            sdpResponse = await fetch(
                "https://api.openai.com/v1/realtime/calls",
                {
                    method: "POST",
                    body: offer.sdp,
                    headers: {
                        Authorization: `Bearer ${key}`,
                        "Content-Type": "application/sdp"
                    }
                }
            );
        } catch (err) {
            throw new Error(
                "The browser could not reach OpenAI to connect the voice call. " +
                "Check your connection, VPN/firewall, or browser extensions. " +
                "The browser console may show a network or CORS error. " +
                `Details: ${err.message}`,
                { cause: err }
            );
        }


        if (!sdpResponse.ok) {
            throw Error(
                `SDP failed ${sdpResponse.status}: ` +
                await sdpResponse.text()
            );
        }


        // --------------------------------------------------
        // Make sure this is still the active call.
        // --------------------------------------------------

        if (
            callId !== activeCallId ||
            pc !== callPc
        ) {
            return;
        }


        const answerSdp =
            await sdpResponse.text();


        await pc.setRemoteDescription({
            type: "answer",
            sdp: answerSdp
        });


        // --------------------------------------------------
        // CALL READY
        // --------------------------------------------------

        log(
            "6/6 Voice loop ready."
        );


        // Keep microphone gated until the simulated telephone connects.
        $("endBtn").disabled = false;
        if (callDc.readyState === "open") {
            beginRinging(callId);
        } else {
            callDc.addEventListener("open", () => {
                if (callId === activeCallId) beginRinging(callId);
            }, {once: true});
        }


    } catch (err) {

        error(
            err.stack ||
            err.message
        );


        end(false);
    }
}


function events(message) {
    if (message.type === "input_audio_buffer.speech_started") pendingAgentSpeech = true;
    if (message.type === "input_audio_buffer.speech_stopped") pendingAgentSpeech = false;
    if (message.type === "conversation.item.created" && message.item?.id) {
        turnStartTimes.set(message.item.id, Date.now());
        if (message.item.type === "message" && message.item.role === "user") pendingTranscripts.add(message.item.id);
    }
    if (message.type === "conversation.item.input_audio_transcription.failed") {
        transcriptIncomplete = true;
        if (message.item_id) pendingTranscripts.delete(message.item_id);
    }


    // --------------------------------------------------
    // OPENAI ERROR
    // --------------------------------------------------

    if (
        message.type ===
        "error"
    ) {

        error(
            JSON.stringify(
                message.error ||
                message,
                null,
                2
            )
        );
    }

    if (message.type === "response.created") {
        log("AI response created", {id: message.response?.id, greetingPending: greetingResponsePending, phase: callPhase});
        if (greetingResponsePending && greetingResponseId === null) {
            if (message.response?.id) {
                greetingResponseId = message.response.id;
            } else {
                error("Realtime created a response without an ID; microphone will remain gated until the opening greeting is identified.");
            }
        }
    }
    if (message.type === "response.done") {
        if (message.response?.status !== "completed") transcriptIncomplete = true;
        log("AI response completed", {id: message.response?.id, status: message.response?.status});
    }
    if (message.type === "response.done" && greetingResponsePending &&
        greetingResponseId !== null && message.response?.id === greetingResponseId) {
        greetingResponsePending = false;
        greetingResponseId = null;
        updateMicrophone();
        if (message.response?.status && message.response.status !== "completed") {
            error("Opening greeting response ended with status: " + message.response.status);
        } else {
            log("Opening greeting completed; microphone input enabled.");
        }
    } else if (message.type === "response.done" && greetingResponsePending) {
        log("Ignoring response.done that does not match the opening greeting.", {
            expected_response_id: greetingResponseId,
            received_response_id: message.response?.id ?? null
        });
    }


    // --------------------------------------------------
    // AGENT TRANSCRIPTION
    // --------------------------------------------------

    if (
        message.type ===
        "conversation.item.input_audio_transcription.completed"
    ) {

        if (message.item_id) pendingTranscripts.delete(message.item_id);
        recordTurn("agent", message.transcript, message.item_id);
        turn("YOU / AGENT", message.transcript, "user");
    }


    // --------------------------------------------------
    // AI TRANSCRIPT STREAMING
    // --------------------------------------------------

    if (
        [
            "response.output_audio_transcript.delta",
            "response.audio_transcript.delta"
        ].includes(
            message.type
        )
    ) {

        aiText +=
            message.delta || "";
    }


    // --------------------------------------------------
    // AI TRANSCRIPT COMPLETED
    // --------------------------------------------------

    if (
        [
            "response.output_audio_transcript.done",
            "response.audio_transcript.done"
        ].includes(
            message.type
        )
    ) {

        const transcriptKey = message.item_id || message.response_id || null;
        if (!transcriptKey || !completedAiTranscripts.has(transcriptKey)) {
            recordTurn("consumer", message.transcript || aiText, message.item_id || message.response_id);
            turn(consumerName, message.transcript || aiText, "ai");
            if (transcriptKey) completedAiTranscripts.add(transcriptKey);
        }


        aiText = "";
    }
}


// --------------------------------------------------
// END / DESTROY CURRENT CALL
// --------------------------------------------------

function end(reset = true) {
    stopRinging();
    pendingCall = false;
    greetingCallId = null;
    greetingResponsePending = false;
    greetingResponseId = null;
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

    aiText = "";
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



// Freeze microphone first, wait briefly for final transcription events, then close.
async function finishAndPrepareResults() {
    if (evaluationBusy) return;
    if (!started) { end(true); return; }
    evaluationBusy = true;
    $("endBtn").disabled = true;
    stream?.getAudioTracks().forEach(t => { t.enabled = false; });
    $("resultsHint").textContent = "Finalizing transcript…";
    const cutoff = Date.now() + 3500;
    // Wait for final agent transcriptions, with a bounded timeout.
    while (pendingTranscripts.size && Date.now() < cutoff) await wait(150);
    // Small grace period for response transcript events to arrive.
    await wait(550);
    if (pendingTranscripts.size || pendingAgentSpeech) transcriptIncomplete = true;
    callEndedAt = Date.now();
    finalizedCall = {
        scenario_id: activeScenarioId,
        turns: evaluationTurns.map(({id,speaker,text,timestamp_ms}) => ({id,speaker,text,timestamp_ms}))
            .sort((a,b) => a.timestamp_ms-b.timestamp_ms || Number(a.id.split("-")[1])-Number(b.id.split("-")[1])),
        metadata: {call_type: callDirection, communication: resolvedVariation.communication,
            difficulty: resolvedVariation.difficulty, duration_ms: callEndedAt - callStartedAt},
        transcript_quality: {incomplete: transcriptIncomplete, pending_turns: pendingTranscripts.size,
            note: "Browser-received speech-to-text transcript; not independently verified against audio."}
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
