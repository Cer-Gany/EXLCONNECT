"use client";

import React, { useEffect, useRef, useState } from "react";

export interface AiInterviewerAvatarProps {
    aiName?: string;
    isSpeaking: boolean;
    isListening?: boolean;
    isProcessing?: boolean;
    isConnected?: boolean;
    ttsAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
    aiTranscript?: string;
    compact?: boolean;
    className?: string;
}

interface Vec2 {
    u: number;
    v: number;
}

interface VisemeState {
    jawOpen: number;      // 0..1: vertical jaw & lower lip drop
    mouthWidth: number;   // -1..1: negative = rounded/pursed ('oo','w'), positive = spread ('ee','s')
    upperLipLift: number; // 0..1: subtle upper lip raise on bilabials/fricatives/smiles
    dentalReveal: number; // 0..1: sibilant/fricative tooth visibility
    tongueLift: number;   // 0..1: alveolar/palatal tongue elevation ('l','n','t','d')
    energy: number;       // 0..1: instantaneous vocal energy
}

/**
 * Compute the 2D affine canvas transform that maps source triangle
 * (s0, s1, s2) in image pixel coordinates to destination triangle
 * (d0, d1, d2) in canvas pixel coordinates.
 */
function setAffineTriangleTransform(
    ctx: CanvasRenderingContext2D,
    s0x: number,
    s0y: number,
    s1x: number,
    s1y: number,
    s2x: number,
    s2y: number,
    d0x: number,
    d0y: number,
    d1x: number,
    d1y: number,
    d2x: number,
    d2y: number
): boolean {
    const det = (s1x - s0x) * (s2y - s0y) - (s2x - s0x) * (s1y - s0y);
    if (Math.abs(det) < 1e-5) return false;
    const invDet = 1 / det;

    const a = ((d1x - d0x) * (s2y - s0y) - (d2x - d0x) * (s1y - s0y)) * invDet;
    const b = ((d1y - d0y) * (s2y - s0y) - (d2y - d0y) * (s1y - s0y)) * invDet;
    const c = ((d2x - d0x) * (s1x - s0x) - (d1x - d0x) * (s2x - s0x)) * invDet;
    const d = ((d2y - d0y) * (s1x - s0x) - (d1y - d0y) * (s2x - s0x)) * invDet;
    const e = d0x - a * s0x - c * s0y;
    const f = d0y - b * s0x - d * s0y;

    ctx.setTransform(a, b, c, d, e, f);
    return true;
}

/**
 * Draw a single warped triangle from `img` onto `ctx` with slight sub-pixel clip
 * dilation (0.65px) so adjacent triangles never show antialiasing seams.
 */
function drawWarpedTriangle(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    s0: Vec2,
    s1: Vec2,
    s2: Vec2,
    d0: Vec2,
    d1: Vec2,
    d2: Vec2,
    imgW: number,
    imgH: number,
    dstW: number,
    dstH: number
) {
    const s0x = s0.u * imgW;
    const s0y = s0.v * imgH;
    const s1x = s1.u * imgW;
    const s1y = s1.v * imgH;
    const s2x = s2.u * imgW;
    const s2y = s2.v * imgH;

    const d0x = d0.u * dstW;
    const d0y = d0.v * dstH;
    const d1x = d1.u * dstW;
    const d1y = d1.v * dstH;
    const d2x = d2.u * dstW;
    const d2y = d2.v * dstH;

    const cx = (d0x + d1x + d2x) / 3;
    const cy = (d0y + d1y + d2y) / 3;
    const expand = 0.65;

    const expandPt = (px: number, py: number): [number, number] => {
        const dx = px - cx;
        const dy = py - cy;
        const len = Math.hypot(dx, dy) || 1;
        return [px + (dx / len) * expand, py + (dy / len) * expand];
    };

    const [c0x, c0y] = expandPt(d0x, d0y);
    const [c1x, c1y] = expandPt(d1x, d1y);
    const [c2x, c2y] = expandPt(d2x, d2y);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c0x, c0y);
    ctx.lineTo(c1x, c1y);
    ctx.lineTo(c2x, c2y);
    ctx.closePath();
    ctx.clip();

    if (
        setAffineTriangleTransform(
            ctx,
            s0x,
            s0y,
            s1x,
            s1y,
            s2x,
            s2y,
            d0x,
            d0y,
            d1x,
            d1y,
            d2x,
            d2y
        )
    ) {
        ctx.drawImage(img, 0, 0);
    }
    ctx.restore();
}

/**
 * Derive realistic viseme parameters from transcript text + elapsed time when
 * Web Audio AnalyserNode data is not active (e.g., chat mode or fallback).
 */
function sampleTranscriptViseme(text: string, timeSec: number): VisemeState {
    const clean = text.trim().toLowerCase();
    const charIdx = Math.floor(timeSec * 14) % Math.max(1, clean.length);
    const ch = clean[charIdx] || "a";
    const syllabicPulse =
        0.5 +
        0.35 * Math.sin(timeSec * 19.5) +
        0.2 * Math.sin(timeSec * 11.3 + 0.8);

    let jaw = 0.35 * syllabicPulse;
    let width = 0.0;
    let upperLift = 0.15;
    let dental = 0.25;
    let tongue = 0.2;

    if ("aáä".includes(ch)) {
        jaw = 0.72 * syllabicPulse;
        width = 0.12;
        dental = 0.35;
    } else if ("oóöuúüw".includes(ch)) {
        jaw = 0.48 * syllabicPulse;
        width = -0.55;
        upperLift = 0.1;
        dental = 0.12;
    } else if ("eéiy".includes(ch)) {
        jaw = 0.36 * syllabicPulse;
        width = 0.52;
        upperLift = 0.35;
        dental = 0.65;
    } else if ("bmp".includes(ch)) {
        jaw = 0.04;
        width = -0.15;
        upperLift = 0.02;
        dental = 0.0;
    } else if ("fv".includes(ch)) {
        jaw = 0.16;
        width = 0.2;
        upperLift = 0.38;
        dental = 0.8;
    } else if ("szc".includes(ch)) {
        jaw = 0.18;
        width = 0.42;
        upperLift = 0.3;
        dental = 0.85;
    } else if ("lntd".includes(ch)) {
        jaw = 0.34 * syllabicPulse;
        width = 0.15;
        tongue = 0.75;
        dental = 0.45;
    }

    return {
        jawOpen: Math.max(0, Math.min(1, jaw)),
        mouthWidth: Math.max(-1, Math.min(1, width)),
        upperLipLift: Math.max(0, Math.min(1, upperLift)),
        dentalReveal: Math.max(0, Math.min(1, dental)),
        tongueLift: Math.max(0, Math.min(1, tongue)),
        energy: Math.max(0.15, Math.min(1, jaw * 1.15)),
    };
}

/**
 * Sample real-time formant bands from the Web Audio AnalyserNode connected
 * directly to the AI TTS output stream:
 * - Low band (85-350 Hz): Fundamental voiced energy / bilabial closure detection
 * - F1 Open vowel band (350-950 Hz): Drives vertical jaw & lower-lip opening ('ah', 'eh', 'oh')
 * - F2 Spread vowel band (1000-2600 Hz): Drives lip corner spread ('ee', 'ih') vs rounding ('oo', 'w')
 * - Sibilant / fricative band (2800-6500 Hz): Drives upper lip lift & dental reveal ('s', 'sh', 'f', 'v')
 */
function sampleAnalyserViseme(
    analyser: AnalyserNode,
    freqBuf: Uint8Array<ArrayBuffer>,
    timeBuf: Uint8Array<ArrayBuffer>,
    timeSec: number
): VisemeState {
    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);

    // Compute time-domain RMS for crisp syllabic envelope and plosive closures
    let sumSq = 0;
    for (let i = 0; i < timeBuf.length; i++) {
        const centered = (timeBuf[i] - 128) / 128;
        sumSq += centered * centered;
    }
    const rms = Math.sqrt(sumSq / timeBuf.length);

    const sampleRate = analyser.context.sampleRate || 24000;
    const binHz = sampleRate / analyser.fftSize;

    const avgBand = (lowHz: number, highHz: number): number => {
        const startBin = Math.max(1, Math.floor(lowHz / binHz));
        const endBin = Math.min(
            freqBuf.length - 1,
            Math.ceil(highHz / binHz)
        );
        if (endBin < startBin) return 0;
        let sum = 0;
        for (let i = startBin; i <= endBin; i++) {
            sum += freqBuf[i];
        }
        return sum / ((endBin - startBin + 1) * 255);
    };

    const f0Voiced = avgBand(90, 340);     // Fundamental pitch & low rounding
    const f1Open = avgBand(340, 980);      // First formant: jaw opening ('aa', 'ae', 'ao')
    const f2Front = avgBand(1050, 2550);   // Second formant: front vowel spread ('iy', 'eh')
    const sibilant = avgBand(2700, 6200);  // Fricatives & sibilants ('s', 'z', 'sh', 'f')

    // Noise gate so silent gaps between words close the lips cleanly
    const rawEnergy = Math.max(rms * 3.6, f1Open * 1.25 + f2Front * 0.9);
    if (rawEnergy < 0.035) {
        return {
            jawOpen: 0,
            mouthWidth: 0,
            upperLipLift: 0,
            dentalReveal: 0,
            tongueLift: 0,
            energy: 0,
        };
    }

    // Jaw opening is primarily driven by F1 energy and RMS envelope, damped during pure sibilants
    const sibilantDominance = Math.max(0, sibilant - f1Open * 0.75);
    const rawJaw =
        (f1Open * 1.45 + rms * 2.1 - sibilantDominance * 0.55) *
        (0.92 + 0.08 * Math.sin(timeSec * 18));
    const jawOpen = Math.max(0, Math.min(1, Math.pow(Math.max(0, rawJaw), 0.85)));

    // Lip spread vs rounding: high F2/F1 ratio = wide ('ee'), high F0+low F2 = rounded ('oo', 'oh')
    const spreadSignal = (f2Front * 1.55 + sibilant * 0.65) - (f0Voiced * 0.85 + f1Open * 0.35);
    const mouthWidth = Math.max(-0.75, Math.min(0.75, spreadSignal * 1.8));

    // Upper lip lift & dental visibility
    const upperLipLift = Math.max(
        0,
        Math.min(1, f2Front * 0.9 + sibilant * 1.2 + jawOpen * 0.35)
    );
    const dentalReveal = Math.max(
        0,
        Math.min(1, sibilant * 1.65 + f2Front * 0.85 + jawOpen * 0.3)
    );
    const tongueLift = Math.max(
        0,
        Math.min(1, f2Front * 1.15 * (1 - sibilant * 0.6))
    );

    return {
        jawOpen,
        mouthWidth,
        upperLipLift,
        dentalReveal,
        tongueLift,
        energy: Math.min(1, rawEnergy),
    };
}

/**
 * Base normalized facial mesh vertices calibrated to `/images/ai-interviewer.jpg` (1024x1024).
 * Vertices 13, 14, 15 and 16, 17, 18 share the exact closed-lip parting seam in the source
 * portrait so that displacing 13..15 upward and 16..18 downward parts the lips naturally.
 */
const BASE_MOUTH_MESH: Vec2[] = [
    // Outer ring (static boundary around nose, cheeks, lower neck)
    { u: 0.370, v: 0.340 }, // 0: Top-left cheek anchor
    { u: 0.462, v: 0.345 }, // 1: Left nostril base
    { u: 0.506, v: 0.347 }, // 2: Subnasale (philtrum top)
    { u: 0.550, v: 0.345 }, // 3: Right nostril base
    { u: 0.640, v: 0.340 }, // 4: Top-right cheek anchor
    { u: 0.655, v: 0.405 }, // 5: Mid-right cheek anchor
    { u: 0.635, v: 0.495 }, // 6: Lower-right jaw/neck anchor
    { u: 0.505, v: 0.525 }, // 7: Mid-neck anchor below chin
    { u: 0.375, v: 0.495 }, // 8: Lower-left jaw/neck anchor
    { u: 0.355, v: 0.405 }, // 9: Mid-left cheek anchor

    // Upper lip vermilion top border (Cupid's bow)
    { u: 0.478, v: 0.386 }, // 10: Upper lip top-left
    { u: 0.506, v: 0.385 }, // 11: Upper lip Cupid's bow center
    { u: 0.534, v: 0.386 }, // 12: Upper lip top-right

    // Mouth corners & Upper inner lip seam
    { u: 0.460, v: 0.394 }, // 13: Left mouth corner (commissure)
    { u: 0.484, v: 0.396 }, // 14: Upper lip inner-left seam
    { u: 0.506, v: 0.397 }, // 15: Upper lip inner-center seam
    { u: 0.528, v: 0.396 }, // 16: Upper lip inner-right seam
    { u: 0.551, v: 0.395 }, // 17: Right mouth corner (commissure)

    // Lower inner lip seam (coincident with 14, 15, 16 at rest in source portrait)
    { u: 0.484, v: 0.396 }, // 18: Lower lip inner-left seam
    { u: 0.506, v: 0.397 }, // 19: Lower lip inner-center seam
    { u: 0.528, v: 0.396 }, // 20: Lower lip inner-right seam

    // Lower lip vermilion bottom border
    { u: 0.478, v: 0.412 }, // 21: Lower lip bottom-left
    { u: 0.506, v: 0.415 }, // 22: Lower lip bottom-center
    { u: 0.534, v: 0.412 }, // 23: Lower lip bottom-right

    // Chin & jawline (moves with jaw drop)
    { u: 0.445, v: 0.452 }, // 24: Left chin/jaw contour
    { u: 0.505, v: 0.466 }, // 25: Menton (chin bottom tip)
    { u: 0.565, v: 0.452 }, // 26: Right chin/jaw contour
];

/**
 * Triangle indices covering the philtrum, cheeks, upper lip, lower lip, and chin
 * (excluding the inner oral cavity polygon [13, 14, 15, 16, 17, 20, 19, 18] which opens up).
 */
const MOUTH_TRIANGLES: [number, number, number][] = [
    // Philtrum & upper cheeks
    [0, 1, 9],
    [1, 13, 9],
    [1, 10, 13],
    [1, 2, 10],
    [2, 11, 10],
    [2, 12, 11],
    [2, 3, 12],
    [3, 17, 12],
    [3, 4, 5],
    [3, 5, 17],

    // Upper lip vermilion (stretches & lifts seamlessly with upper seam)
    [13, 10, 14],
    [10, 11, 14],
    [11, 15, 14],
    [11, 12, 15],
    [12, 16, 15],
    [12, 17, 16],

    // Lower lip vermilion (drops with lower seam [18,19,20] and bottom lip [21,22,23])
    [13, 18, 21],
    [18, 19, 21],
    [19, 22, 21],
    [19, 20, 22],
    [20, 23, 22],
    [20, 17, 23],

    // Lateral cheeks next to mouth corners
    [9, 13, 24],
    [13, 21, 24],
    [9, 24, 8],
    [17, 5, 26],
    [17, 26, 23],
    [26, 5, 6],

    // Chin pad (between lower lip bottom and chin tip)
    [21, 25, 24],
    [21, 22, 25],
    [22, 23, 25],
    [23, 26, 25],

    // Submental / neck transition (absorbs downward jaw motion into static neck anchors)
    [8, 24, 7],
    [24, 25, 7],
    [25, 26, 7],
    [26, 6, 7],
];

/**
 * Eye blink mesh for smooth natural eyelid closure over both eyes.
 */
const BASE_EYE_MESH: Vec2[] = [
    // Left eye (viewer's left)
    { u: 0.420, v: 0.262 }, // 0: Left brow/lid anchor
    { u: 0.456, v: 0.258 }, // 1: Center brow/lid anchor
    { u: 0.490, v: 0.262 }, // 2: Right brow/lid anchor
    { u: 0.430, v: 0.292 }, // 3: Left eye inner/outer corner
    { u: 0.456, v: 0.279 }, // 4: Left upper eyelid crease (moves down to 0.301 on blink)
    { u: 0.482, v: 0.292 }, // 5: Left eye corner
    { u: 0.456, v: 0.303 }, // 6: Left lower eyelid rim
    { u: 0.456, v: 0.320 }, // 7: Left under-eye anchor

    // Right eye (viewer's right)
    { u: 0.522, v: 0.262 }, // 8: Left brow/lid anchor
    { u: 0.556, v: 0.258 }, // 9: Center brow/lid anchor
    { u: 0.592, v: 0.262 }, // 10: Right brow/lid anchor
    { u: 0.528, v: 0.291 }, // 11: Right eye corner
    { u: 0.556, v: 0.277 }, // 12: Right upper eyelid crease (moves down to 0.299 on blink)
    { u: 0.582, v: 0.291 }, // 13: Right eye corner
    { u: 0.556, v: 0.301 }, // 14: Right lower eyelid rim
    { u: 0.556, v: 0.320 }, // 15: Right under-eye anchor
];

const EYE_TRIANGLES: [number, number, number][] = [
    // Left eye upper lid & sclera cover
    [0, 1, 3],
    [1, 4, 3],
    [1, 2, 4],
    [2, 5, 4],
    [3, 4, 6],
    [4, 5, 6],
    [3, 6, 7],
    [6, 5, 7],

    // Right eye upper lid & sclera cover
    [8, 9, 11],
    [9, 12, 11],
    [9, 10, 12],
    [10, 13, 12],
    [11, 12, 14],
    [12, 13, 14],
    [11, 14, 15],
    [14, 13, 15],
];

export const AiInterviewerAvatar: React.FC<AiInterviewerAvatarProps> = ({
    aiName = "Sarah (AI Interviewer)",
    isSpeaking,
    isListening = false,
    isProcessing = false,
    isConnected = true,
    ttsAnalyserRef,
    aiTranscript = "",
    compact = false,
    className = "",
}) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [imageLoaded, setImageLoaded] = useState(false);

    // Keep latest props in refs so the 60fps requestAnimationFrame loop never restarts
    const isSpeakingRef = useRef(isSpeaking);
    const isListeningRef = useRef(isListening);
    const isProcessingRef = useRef(isProcessing);
    const aiTranscriptRef = useRef(aiTranscript);

    useEffect(() => {
        isSpeakingRef.current = isSpeaking;
    }, [isSpeaking]);
    useEffect(() => {
        isListeningRef.current = isListening;
    }, [isListening]);
    useEffect(() => {
        isProcessingRef.current = isProcessing;
    }, [isProcessing]);
    useEffect(() => {
        aiTranscriptRef.current = aiTranscript;
    }, [aiTranscript]);

    useEffect(() => {
        const img = new Image();
        img.src = "/images/ai-interviewer.jpg";
        let rafId = 0;
        let mounted = true;

        // Smoothed viseme state for organic inertia (fast attack, smooth decay)
        const smooth: VisemeState = {
            jawOpen: 0,
            mouthWidth: 0,
            upperLipLift: 0,
            dentalReveal: 0,
            tongueLift: 0,
            energy: 0,
        };

        // Natural blink scheduler
        let nextBlinkAt = performance.now() + 2400 + Math.random() * 2500;
        let blinkStartAt = -1;
        const blinkDurationMs = 155;

        let freqBuf: Uint8Array<ArrayBuffer> | null = null;
        let timeBuf: Uint8Array<ArrayBuffer> | null = null;

        img.onload = () => {
            if (!mounted) return;
            setImageLoaded(true);
        };

        const renderFrame = (nowMs: number) => {
            if (!mounted) return;
            rafId = requestAnimationFrame(renderFrame);

            const canvas = canvasRef.current;
            if (!canvas || !img.complete || img.naturalWidth === 0) return;

            const ctx = canvas.getContext("2d");
            if (!ctx) return;

            const timeSec = nowMs * 0.001;
            const speaking = isSpeakingRef.current;
            const listening = isListeningRef.current;
            const processing = isProcessingRef.current;

            // 1. Sample target viseme from Web Audio AnalyserNode (exact TTS sample sync) or transcript fallback
            let target: VisemeState = {
                jawOpen: 0,
                mouthWidth: listening ? 0.08 : 0, // subtle attentive smile when listening
                upperLipLift: 0,
                dentalReveal: 0,
                tongueLift: 0,
                energy: 0,
            };

            const analyser = ttsAnalyserRef?.current ?? null;
            if (speaking && analyser) {
                if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
                    freqBuf = new Uint8Array(analyser.frequencyBinCount);
                    timeBuf = new Uint8Array(analyser.fftSize);
                }
                target = sampleAnalyserViseme(
                    analyser,
                    freqBuf,
                    timeBuf!,
                    timeSec
                );
                // If `isSpeaking` is true right at utterance start before first PCM buffer hits speakers,
                // blend in gentle preparatory articulation
                if (target.energy < 0.02 && aiTranscriptRef.current) {
                    target = sampleTranscriptViseme(
                        aiTranscriptRef.current,
                        timeSec
                    );
                }
            } else if (speaking) {
                target = sampleTranscriptViseme(
                    aiTranscriptRef.current || "Hello, let us discuss your approach",
                    timeSec
                );
            }

            // 2. Asymmetric smoothing: crisp attack (0.42) for plosives/vowels, natural jaw/lip closing decay (0.22)
            const lerpViseme = (curr: number, tgt: number, attack: number, release: number) => {
                const rate = Math.abs(tgt) > Math.abs(curr) ? attack : release;
                return curr + (tgt - curr) * rate;
            };

            smooth.jawOpen = lerpViseme(smooth.jawOpen, target.jawOpen, 0.44, 0.24);
            smooth.mouthWidth = lerpViseme(smooth.mouthWidth, target.mouthWidth, 0.36, 0.20);
            smooth.upperLipLift = lerpViseme(smooth.upperLipLift, target.upperLipLift, 0.40, 0.22);
            smooth.dentalReveal = lerpViseme(smooth.dentalReveal, target.dentalReveal, 0.42, 0.25);
            smooth.tongueLift = lerpViseme(smooth.tongueLift, target.tongueLift, 0.35, 0.22);
            smooth.energy = lerpViseme(smooth.energy, target.energy, 0.45, 0.20);

            // 3. Natural eye blink curve
            if (nowMs >= nextBlinkAt && blinkStartAt < 0) {
                blinkStartAt = nowMs;
            }
            let blinkAmount = 0;
            if (blinkStartAt >= 0) {
                const elapsed = nowMs - blinkStartAt;
                if (elapsed >= blinkDurationMs) {
                    blinkStartAt = -1;
                    // Occasional double-blink when transitioning states or speaking
                    const doubleBlink = Math.random() < 0.16;
                    nextBlinkAt =
                        nowMs +
                        (doubleBlink ? 180 : 2400 + Math.random() * 3400);
                } else {
                    const phase = elapsed / blinkDurationMs;
                    blinkAmount = Math.sin(phase * Math.PI);
                }
            }

            // 4. Organic head micro-motion, breathing, and attentive nods
            const breathY = Math.sin(timeSec * 1.65) * 0.0028;
            const breathScale = 1 + Math.sin(timeSec * 1.65) * 0.0025;
            const talkNodY =
                speaking
                    ? Math.sin(timeSec * 4.8) * 0.0022 * smooth.energy +
                      smooth.jawOpen * 0.0018
                    : listening
                      ? Math.sin(timeSec * 2.7) * 0.0020 // subtle listening nod
                      : 0;
            const headSwayX =
                Math.sin(timeSec * 0.85) * 0.0024 +
                (speaking ? Math.cos(timeSec * 2.3) * 0.0018 * smooth.energy : 0);
            const headTiltRad =
                Math.sin(timeSec * 0.72) * 0.0055 +
                (listening ? 0.006 : 0) +
                (processing ? -0.005 : 0);

            const cw = canvas.width;
            const ch = canvas.height;
            const imgW = img.naturalWidth;
            const imgH = img.naturalHeight;

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, cw, ch);

            // Compute cover-fit rectangle with subtle zoom crop around head & shoulders
            const zoom = compact ? 1.18 : 1.08;
            const drawW = cw * zoom * breathScale;
            const drawH = ch * zoom * breathScale;
            const offsetX = (cw - drawW) * 0.5 + headSwayX * cw;
            const offsetY =
                (ch - drawH) * (compact ? 0.22 : 0.32) +
                (breathY + talkNodY) * ch;

            ctx.save();
            // Apply subtle organic head tilt around the neck pivot (0.5, 0.58)
            const pivotX = offsetX + drawW * 0.505;
            const pivotY = offsetY + drawH * 0.58;
            ctx.translate(pivotX, pivotY);
            ctx.rotate(headTiltRad);
            ctx.translate(-pivotX, -pivotY);

            // Draw base photorealistic portrait
            ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

            // Helper to convert normalized image (u, v) to current canvas coordinates
            const toCanvasUV = (pt: Vec2): Vec2 => ({
                u: (offsetX + pt.u * drawW) / cw,
                v: (offsetY + pt.v * drawH) / ch,
            });

            // 5. Deform Mouth, Lip, Cheek & Jaw Mesh
            const jawDropV = smooth.jawOpen * 0.0255;       // Max ~26px vertical opening at 1024px
            const cornerSpreadU = smooth.mouthWidth * 0.0075; // Corner horizontal widen/round
            const cornerLiftV = -smooth.mouthWidth * 0.0018;  // Subtle corner lift when spread
            const upperLiftV =
                smooth.upperLipLift * 0.0032 + smooth.jawOpen * 0.0022;

            const dstMouth: Vec2[] = BASE_MOUTH_MESH.map((pt, idx) => {
                let u = pt.u;
                let v = pt.v;

                switch (idx) {
                    // Upper lip vermilion top border (Cupid's bow)
                    case 10:
                    case 12:
                        u += (idx === 10 ? -0.35 : 0.35) * cornerSpreadU;
                        v -= upperLiftV * 0.72;
                        break;
                    case 11:
                        v -= upperLiftV * 0.85;
                        break;

                    // Left & Right mouth corners (commissures)
                    case 13:
                        u -= cornerSpreadU;
                        v += jawDropV * 0.18 + cornerLiftV;
                        break;
                    case 17:
                        u += cornerSpreadU;
                        v += jawDropV * 0.18 + cornerLiftV;
                        break;

                    // Upper inner lip seam (parts slightly upward to expose upper teeth)
                    case 14:
                    case 16:
                        u += (idx === 14 ? -0.45 : 0.45) * cornerSpreadU;
                        v -= upperLiftV * 0.92;
                        break;
                    case 15:
                        v -= upperLiftV * 1.05;
                        break;

                    // Lower inner lip seam (drops cleanly with jawOpen)
                    case 18:
                    case 20:
                        u += (idx === 18 ? -0.45 : 0.45) * cornerSpreadU;
                        v += jawDropV * 0.82;
                        break;
                    case 19:
                        v += jawDropV * 0.98;
                        break;

                    // Lower lip vermilion bottom border
                    case 21:
                    case 23:
                        u += (idx === 21 ? -0.35 : 0.35) * cornerSpreadU;
                        v += jawDropV * 0.86;
                        break;
                    case 22:
                        v += jawDropV * 0.96;
                        break;

                    // Chin & lower jawline (moves naturally with mandible)
                    case 24:
                    case 26:
                        v += jawDropV * 0.56;
                        break;
                    case 25:
                        v += jawDropV * 0.72;
                        break;
                    default:
                        break;
                }

                return toCanvasUV({ u, v });
            });

            // 6. Render realistic shaded inner oral cavity, teeth, and tongue BEFORE drawing warped lip triangles
            if (smooth.jawOpen > 0.012 || smooth.upperLipLift > 0.04) {
                const p13 = {
                    x: dstMouth[13].u * cw,
                    y: dstMouth[13].v * ch,
                };
                const p14 = {
                    x: dstMouth[14].u * cw,
                    y: dstMouth[14].v * ch,
                };
                const p15 = {
                    x: dstMouth[15].u * cw,
                    y: dstMouth[15].v * ch,
                };
                const p16 = {
                    x: dstMouth[16].u * cw,
                    y: dstMouth[16].v * ch,
                };
                const p17 = {
                    x: dstMouth[17].u * cw,
                    y: dstMouth[17].v * ch,
                };
                const p20 = {
                    x: dstMouth[20].u * cw,
                    y: dstMouth[20].v * ch,
                };
                const p19 = {
                    x: dstMouth[19].u * cw,
                    y: dstMouth[19].v * ch,
                };
                const p18 = {
                    x: dstMouth[18].u * cw,
                    y: dstMouth[18].v * ch,
                };

                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);

                // Clip strictly to the curved inner lip opening
                ctx.beginPath();
                ctx.moveTo(p13.x, p13.y);
                ctx.quadraticCurveTo(p14.x, p14.y, p15.x, p15.y);
                ctx.quadraticCurveTo(p16.x, p16.y, p17.x, p17.y);
                ctx.quadraticCurveTo(p20.x, p20.y, p19.x, p19.y);
                ctx.quadraticCurveTo(p18.x, p18.y, p13.x, p13.y);
                ctx.closePath();
                ctx.clip();

                const mouthWidthPx = p17.x - p13.x;
                const mouthHeightPx = Math.max(1, p19.y - p15.y);

                // Deep oral cavity background gradient
                const cavityGrad = ctx.createRadialGradient(
                    p15.x,
                    (p15.y + p19.y) * 0.5,
                    mouthHeightPx * 0.08,
                    p15.x,
                    (p15.y + p19.y) * 0.5,
                    mouthWidthPx * 0.55
                );
                cavityGrad.addColorStop(0, "#1c090c");
                cavityGrad.addColorStop(0.65, "#2b0f14");
                cavityGrad.addColorStop(1, "#140608");
                ctx.fillStyle = cavityGrad;
                ctx.fillRect(
                    p13.x - 4,
                    p15.y - 6,
                    mouthWidthPx + 8,
                    mouthHeightPx + 12
                );

                // Soft anatomical tongue in lower rear cavity (elevates on alveolar phonemes 'l','n','t','d')
                const tongueTopY =
                    p19.y -
                    mouthHeightPx * (0.28 + smooth.tongueLift * 0.34);
                const tongueGrad = ctx.createLinearGradient(
                    p15.x,
                    tongueTopY,
                    p15.x,
                    p19.y + 4
                );
                tongueGrad.addColorStop(0, "#9e4752");
                tongueGrad.addColorStop(0.55, "#7c2e38");
                tongueGrad.addColorStop(1, "#4e1920");
                ctx.fillStyle = tongueGrad;
                ctx.beginPath();
                ctx.ellipse(
                    p15.x,
                    p19.y + mouthHeightPx * 0.05,
                    mouthWidthPx * 0.34,
                    Math.max(1.5, p19.y - tongueTopY),
                    0,
                    Math.PI,
                    0,
                    false
                );
                ctx.fill();

                // Upper dental arch (natural ivory shading with subtle tooth-edge definition & lateral shadow)
                const upperTeethDrop =
                    Math.min(
                        mouthHeightPx * 0.44,
                        drawH * (0.0045 + smooth.dentalReveal * 0.0042)
                    );
                const teethTopY = p15.y - drawH * 0.0018;
                const teethBotY = teethTopY + upperTeethDrop;

                const teethGrad = ctx.createLinearGradient(
                    p13.x,
                    teethTopY,
                    p17.x,
                    teethTopY
                );
                teethGrad.addColorStop(0, "rgba(135, 115, 112, 0.85)");
                teethGrad.addColorStop(0.18, "rgba(232, 224, 218, 0.96)");
                teethGrad.addColorStop(0.5, "rgba(247, 241, 236, 0.98)");
                teethGrad.addColorStop(0.82, "rgba(232, 224, 218, 0.96)");
                teethGrad.addColorStop(1, "rgba(135, 115, 112, 0.85)");

                ctx.fillStyle = teethGrad;
                ctx.beginPath();
                ctx.moveTo(p13.x + mouthWidthPx * 0.08, teethTopY);
                ctx.lineTo(p17.x - mouthWidthPx * 0.08, teethTopY);
                ctx.quadraticCurveTo(
                    p15.x,
                    teethBotY + drawH * 0.0015,
                    p13.x + mouthWidthPx * 0.08,
                    teethTopY
                );
                ctx.closePath();
                ctx.fill();

                // Subtle lower teeth hint on wider openings or sibilants
                if (smooth.jawOpen > 0.25 || smooth.dentalReveal > 0.5) {
                    const lowerTeethH = Math.min(
                        mouthHeightPx * 0.22,
                        drawH * 0.0032
                    );
                    ctx.fillStyle = "rgba(218, 208, 202, 0.78)";
                    ctx.beginPath();
                    ctx.ellipse(
                        p19.x,
                        p19.y + drawH * 0.0005,
                        mouthWidthPx * 0.30,
                        lowerTeethH,
                        0,
                        Math.PI,
                        0,
                        false
                    );
                    ctx.fill();
                }

                // Soft upper-lip cast shadow onto upper teeth & oral cavity for realistic depth
                const lipShadowGrad = ctx.createLinearGradient(
                    p15.x,
                    p15.y - 1,
                    p15.x,
                    p15.y + Math.max(3, mouthHeightPx * 0.36)
                );
                lipShadowGrad.addColorStop(0, "rgba(24, 8, 11, 0.72)");
                lipShadowGrad.addColorStop(0.5, "rgba(24, 8, 11, 0.24)");
                lipShadowGrad.addColorStop(1, "rgba(24, 8, 11, 0)");
                ctx.fillStyle = lipShadowGrad;
                ctx.fillRect(
                    p13.x - 2,
                    p15.y - 2,
                    mouthWidthPx + 4,
                    mouthHeightPx * 0.45
                );

                // Inner lip rim anti-aliasing blend
                ctx.strokeStyle = "rgba(72, 24, 30, 0.55)";
                ctx.lineWidth = Math.max(1, drawH * 0.0018);
                ctx.stroke();

                ctx.restore();
            }

            // 7. Render the piecewise-affine warped facial triangles over the mouth, lips, chin, and cheeks
            for (let i = 0; i < MOUTH_TRIANGLES.length; i++) {
                const [i0, i1, i2] = MOUTH_TRIANGLES[i];
                drawWarpedTriangle(
                    ctx,
                    img,
                    BASE_MOUTH_MESH[i0],
                    BASE_MOUTH_MESH[i1],
                    BASE_MOUTH_MESH[i2],
                    dstMouth[i0],
                    dstMouth[i1],
                    dstMouth[i2],
                    imgW,
                    imgH,
                    cw,
                    ch
                );
            }

            // 8. Render natural Eyelid Blink Mesh when blinking
            if (blinkAmount > 0.01) {
                const dstEyes: Vec2[] = BASE_EYE_MESH.map((pt, idx) => {
                    let v = pt.v;
                    // Move upper eyelid crease vertices (4 = left eye, 12 = right eye) down to the lower lid rim
                    if (idx === 4) {
                        v = pt.v + (0.302 - pt.v) * blinkAmount;
                    } else if (idx === 12) {
                        v = pt.v + (0.300 - pt.v) * blinkAmount;
                    } else if (idx === 6 || idx === 14) {
                        // Subtle lower lid rise during blink
                        v = pt.v - 0.002 * blinkAmount;
                    }
                    return toCanvasUV({ u: pt.u, v });
                });

                for (let i = 0; i < EYE_TRIANGLES.length; i++) {
                    const [i0, i1, i2] = EYE_TRIANGLES[i];
                    drawWarpedTriangle(
                        ctx,
                        img,
                        BASE_EYE_MESH[i0],
                        BASE_EYE_MESH[i1],
                        BASE_EYE_MESH[i2],
                        dstEyes[i0],
                        dstEyes[i1],
                        dstEyes[i2],
                        imgW,
                        imgH,
                        cw,
                        ch
                    );
                }

                // Subtle eyelash crease line when eyelids meet
                if (blinkAmount > 0.55) {
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.strokeStyle = `rgba(28, 18, 16, ${(blinkAmount - 0.5) * 0.85})`;
                    ctx.lineWidth = Math.max(1.2, drawH * 0.0022);
                    ctx.lineCap = "round";

                    // Left lash line
                    ctx.beginPath();
                    ctx.moveTo(dstEyes[3].u * cw, dstEyes[3].v * ch);
                    ctx.quadraticCurveTo(
                        dstEyes[4].u * cw,
                        dstEyes[4].v * ch + 1,
                        dstEyes[5].u * cw,
                        dstEyes[5].v * ch
                    );
                    ctx.stroke();

                    // Right lash line
                    ctx.beginPath();
                    ctx.moveTo(dstEyes[11].u * cw, dstEyes[11].v * ch);
                    ctx.quadraticCurveTo(
                        dstEyes[12].u * cw,
                        dstEyes[12].v * ch + 1,
                        dstEyes[13].u * cw,
                        dstEyes[13].v * ch
                    );
                    ctx.stroke();
                    ctx.restore();
                }
            }

            ctx.restore();
        };

        rafId = requestAnimationFrame(renderFrame);

        return () => {
            mounted = false;
            cancelAnimationFrame(rafId);
        };
    }, [compact, ttsAnalyserRef]);

    const statusLabel = !isConnected
        ? "Offline"
        : isSpeaking
          ? "Speaking"
          : isProcessing
            ? "Thinking..."
            : isListening
              ? "Listening"
              : "Connected";

    if (compact) {
        return (
            <div
                className={`relative flex items-center gap-2.5 rounded-full bg-zinc-900/90 border border-white/10 pl-1 pr-3 py-1 shadow-md ${className}`}
                data-testid="ai-interviewer-avatar-compact"
            >
                <div
                    className={`relative w-8 h-8 rounded-full overflow-hidden ring-2 transition-all duration-300 ${
                        isSpeaking
                            ? "ring-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.55)]"
                            : isListening
                              ? "ring-blue-400/80"
                              : "ring-white/15"
                    }`}
                >
                    <canvas
                        ref={canvasRef}
                        width={160}
                        height={160}
                        className="w-full h-full object-cover"
                    />
                </div>
                <div className="flex flex-col leading-tight">
                    <span className="text-[11px] font-medium text-zinc-100">
                        {aiName}
                    </span>
                    <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                        <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                                isSpeaking
                                    ? "bg-emerald-400 animate-pulse"
                                    : isProcessing
                                      ? "bg-amber-400 animate-pulse"
                                      : isListening
                                        ? "bg-blue-400"
                                        : "bg-zinc-500"
                            }`}
                        />
                        {statusLabel}
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div
            className={`relative select-none rounded-2xl overflow-hidden bg-zinc-950 border transition-all duration-300 shadow-2xl ${
                isSpeaking
                    ? "border-emerald-500/60 shadow-[0_0_35px_-5px_rgba(16,185,129,0.35)]"
                    : isListening
                      ? "border-blue-500/40 shadow-[0_0_25px_-5px_rgba(59,130,246,0.2)]"
                      : "border-white/10"
            } ${className}`}
            data-testid="ai-interviewer-avatar"
        >
            <canvas
                ref={canvasRef}
                width={560}
                height={560}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                    imageLoaded ? "opacity-100" : "opacity-0"
                }`}
            />

            {/* Subtle studio vignette & bottom gradient for live video-call polish */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />

            {/* Top-right LIVE HD indicator */}
            <div className="pointer-events-none absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/55 backdrop-blur-md px-2.5 py-1 border border-white/10">
                <span
                    className={`w-2 h-2 rounded-full ${
                        !isConnected
                            ? "bg-zinc-500"
                            : isSpeaking
                              ? "bg-emerald-400 animate-ping"
                              : isProcessing
                                ? "bg-amber-400 animate-pulse"
                                : "bg-emerald-400"
                    }`}
                />
                <span className="text-[10px] font-semibold tracking-wider uppercase text-zinc-200">
                    {statusLabel}
                </span>
            </div>

            {/* Bottom participant nametag & live voice waveform badge */}
            <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 rounded-lg bg-black/60 backdrop-blur-md px-3 py-1.5 border border-white/10">
                    <span className="text-xs font-medium text-white truncate">
                        {aiName}
                    </span>
                </div>

                {isSpeaking && (
                    <div
                        className="flex items-end gap-0.5 h-5 px-2.5 py-1 rounded-lg bg-emerald-500/20 backdrop-blur-md border border-emerald-400/30"
                        aria-label="AI speaking indicator"
                    >
                        <span className="w-0.5 h-2 bg-emerald-400 rounded-full animate-pulse" />
                        <span className="w-0.5 h-3.5 bg-emerald-400 rounded-full animate-pulse [animation-delay:120ms]" />
                        <span className="w-0.5 h-2.5 bg-emerald-400 rounded-full animate-pulse [animation-delay:240ms]" />
                        <span className="w-0.5 h-3 bg-emerald-400 rounded-full animate-pulse [animation-delay:60ms]" />
                    </div>
                )}
            </div>
        </div>
    );
};
