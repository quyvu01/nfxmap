/**
 * Rounds to `decimals` places, a midpoint to the even digit, as .NET's Math.Round does. The number is rounded as its
 * shortest decimal form (0.125 is "0.125", so it rounds to 0.12), not as its binary value.
 */
export function roundHalfEven(value: number, decimals: number): number {
    if (!Number.isFinite(value)) return value;
    if (decimals === 0) return roundHalfEvenInteger(value);

    // The digits and the position of the decimal point of the shortest form: 1.25e-7 is 125 with point at -6
    const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
    const digits = mantissa.replace('.', '');
    const point = Number(exponentText) + 1; // the digits before the point

    // The digits kept: those before the point and `decimals` after it
    const keep = point + decimals;
    if (keep < 0) return 0 * Math.sign(value) + 0;
    if (keep >= digits.length) return value;

    let kept = keep === 0 ? 0n : BigInt(digits.slice(0, keep));
    const first = digits[keep];
    const rest = digits.slice(keep + 1);
    const lastKeptIsOdd = keep > 0 && Number(digits[keep - 1]) % 2 === 1;
    if (first > '5' || (first === '5' && (/[1-9]/.test(rest) || lastKeptIsOdd))) kept += 1n;

    const rounded = Number(`${kept}e${-decimals}`);
    return (value < 0 ? -rounded : rounded) + 0;
}

function roundHalfEvenInteger(value: number): number {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction > 0.5) return floor + 1 + 0;
    if (fraction < 0.5) return floor + 0;
    return (floor % 2 === 0 ? floor : floor + 1) + 0;
}
