/** Optional synthesized audio, unlocked by a click; no downloads or audio assets. */
export class FlightAudio {
  private context?: AudioContext;
  private wind?: GainNode;
  private tone?: OscillatorNode;
  private toneGain?: GainNode;
  enabled = false;

  async toggle(): Promise<boolean> {
    if (!this.context) {
      this.context = new AudioContext();
      const ctx = this.context;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.3;
      const source = ctx.createBufferSource();
      source.buffer = buffer; source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 650;
      this.wind = ctx.createGain(); this.wind.gain.value = 0;
      source.connect(filter).connect(this.wind).connect(ctx.destination); source.start();
      this.tone = ctx.createOscillator(); this.tone.type = 'sine'; this.tone.frequency.value = 60;
      this.toneGain = ctx.createGain(); this.toneGain.gain.value = 0;
      this.tone.connect(this.toneGain).connect(ctx.destination); this.tone.start();
    }
    await this.context.resume();
    this.enabled = !this.enabled;
    if (!this.enabled) this.update(0, false, false, true);
    return this.enabled;
  }

  update(speed: number, inSpace: boolean, hyper: boolean, paused: boolean) {
    if (!this.context || !this.wind || !this.toneGain || !this.tone) return;
    const active = this.enabled && !paused;
    const now = this.context.currentTime;
    this.wind.gain.setTargetAtTime(active && !inSpace ? Math.min(0.5, speed / 1500) : 0, now, 0.25);
    this.toneGain.gain.setTargetAtTime(active && hyper ? 0.055 : 0, now, 0.3);
    this.tone.frequency.setTargetAtTime(hyper ? 95 : 55, now, 0.2);
  }

  boom(impact = false) {
    if (!this.context || !this.enabled) return;
    const ctx = this.context;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(impact ? 95 : 65, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(18, ctx.currentTime + 0.6);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.75);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}
