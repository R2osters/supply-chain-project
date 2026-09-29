# scripts/music/springs.py — same formula as src/lib/spring.ts, time in seconds.
import math


def damped_spring(t: float, from_: float, to: float, damping: float, stiffness: float, mass: float = 1.0) -> float:
    if t <= 0:
        return from_
    w0 = math.sqrt(stiffness / mass)
    zeta = damping / (2 * math.sqrt(stiffness * mass))
    x0 = from_ - to
    if zeta < 1:
        wd = w0 * math.sqrt(1 - zeta * zeta)
        return to + math.exp(-zeta * w0 * t) * x0 * (math.cos(wd * t) + (zeta * w0 / wd) * math.sin(wd * t))
    return to + x0 * (1 + w0 * t) * math.exp(-w0 * t)
