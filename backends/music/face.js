/** DeepFish DanceFaceTick timing and shuffle bag, independent of renderer and real time. */
export const MUSIC_FACES = [
  { EyeOpen: -1, EyeSmile: 1, ParamMouthForm: 0.9 },
  { EyeOpen: -1, EyeSmile: 1, ParamMouthForm: 1, ParamMouthOpenY: 0.5, JawOpen: 0.25 },
  { EyeOpen: -1, ParamBrowLY: 0.6, ParamBrowRY: 0.6, BrowInnerUp: 0.4 },
];
// EyeOpen=-1 is our clip's relative multiplier delta; native EyeOpen=0 means closed.
export class MusicFaceClock {
  constructor(random = Math.random) { this.random = random; this.reset(); }
  reset() { this.wait = -1; this.remaining = 0; this.mood = -1; this.last = -1; this.bag = []; this.active = false; }
  nextWait() { return 30 + (this.random() * 6 - 3); }
  tick(dt, active) {
    const was = this.active; this.active = active;
    if (!active) {
      if (this.mood >= 0) { this.mood = -1; this.remaining = 0; this.wait = this.nextWait(); }
      return this.mood;
    }
    if (this.wait < 0) this.wait = this.nextWait();
    if (!was || dt <= 0 || dt > 1) return this.mood;
    if (this.mood >= 0) {
      this.remaining -= dt;
      if (this.remaining <= 0) { this.mood = -1; this.wait = this.nextWait(); }
      return this.mood;
    }
    this.wait -= dt;
    if (this.wait > 0) return this.mood;
    if (!this.bag.length) {
      this.bag = [0,1,2];
      for (let i=2;i>0;i--) { const j=Math.floor(this.random()*(i+1)); [this.bag[i],this.bag[j]]=[this.bag[j],this.bag[i]]; }
      if (this.bag[0] === this.last) [this.bag[0],this.bag[2]]=[this.bag[2],this.bag[0]];
    }
    this.mood = this.bag.shift(); this.last = this.mood; this.remaining = 15;
    return this.mood;
  }
}
