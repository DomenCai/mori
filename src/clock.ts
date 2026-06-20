export interface Clock {
  now(): Date;
  nowISO(): string;
}

export interface MutableClock extends Clock {
  set(date: Date): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowISO: () => new Date().toISOString(),
};

export class FixedMutableClock implements MutableClock {
  private current: Date;

  constructor(initial: Date = new Date()) {
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  nowISO(): string {
    return this.current.toISOString();
  }

  set(date: Date): void {
    this.current = new Date(date);
  }
}
