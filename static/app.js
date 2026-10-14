const $ = (id) => document.getElementById(id);

let pc = null;
let dc = null;
let stream = null;
let timer = null;
let started = null;
let muted = false;

let aiText = "";
let consumerName = "Consumer";

let scenarios = [];
let opts = {};
let activeCallId = 0;


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
                `<option value="${scenario.id}">
                    ${scenario.name}
                </option>`
        )
        .join("");

    brief();
    await loadScenarioOptions();
    health();
}


function brief() {
    const scenario = scenarios.find(
        (scenario) => scenario.id === $("scenario").value
    );

    $("scenarioBrief").innerHTML = `
        <b>${scenario.name}</b>
        <br></b>
        <br> <b>Task:</b> ${scenario.collector_brief}</br>
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

    const callId =
        ++activeCallId;

    aiText = "";
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


                status(
                    "Live",
                    "live"
                );


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


        started =
            Date.now();


        timer =
            setInterval(
                tick,
                1000
            );


        $("endBtn").disabled =
            false;

        $("muteBtn").disabled =
            false;


    } catch (err) {

        error(
            err.stack ||
            err.message
        );


        end(false);
    }
}


function events(message) {

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


    // --------------------------------------------------
    // AGENT TRANSCRIPTION
    // --------------------------------------------------

    if (
        message.type ===
        "conversation.item.input_audio_transcription.completed"
    ) {

        turn(
            "YOU / AGENT",
            message.transcript,
            "user"
        );
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

        turn(
            consumerName,
            message.transcript ||
            aiText,
            "ai"
        );


        aiText = "";
    }
}


// --------------------------------------------------
// END / DESTROY CURRENT CALL
// --------------------------------------------------

function end(reset = true) {

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


// --------------------------------------------------
// MUTE
// --------------------------------------------------

function mute() {

    muted =
        !muted;


    stream
        ?.getAudioTracks()
        .forEach(
            (track) => {
                track.enabled =
                    !muted;
            }
        );


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

        brief();
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


$("startBtn").onclick =
    start;


$("endBtn").onclick =
    () => end(true);


$("muteBtn").onclick =
    mute;


$("healthBtn").onclick =
    health;


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