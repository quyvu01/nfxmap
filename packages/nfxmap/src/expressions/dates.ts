/**
 * The date functions. A date is a `Date`, read in UTC: services exchange instants, and UTC gives every service the
 * same year, day and hour for the same instant.
 *
 * `:format(...)` takes the .NET custom date and time patterns of FxMap ('yyyy-MM-dd', 'dd/MM/yyyy HH:mm:ss'), with
 * the invariant culture: English month and day names, AM/PM.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (value: number, length: number) => String(value).padStart(length, '0');

/** Formats a date with a .NET custom pattern, in UTC. */
export function formatDate(date: Date, pattern: string): string {
    if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
    let out = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];

        // Quoted text and escaped characters are literal
        if (c === '\'' || c === '"') {
            let end = pattern.indexOf(c, i + 1);
            if (end < 0) end = pattern.length;
            out += pattern.slice(i + 1, end);
            i = end + 1;
            continue;
        }
        if (c === '\\' && i + 1 < pattern.length) {
            out += pattern[i + 1];
            i += 2;
            continue;
        }

        let run = 1;
        while (i + run < pattern.length && pattern[i + run] === c) run++;
        out += formatRun(date, c, run);
        i += run;
    }
    return out;
}

function formatRun(date: Date, c: string, run: number): string {
    const year = date.getUTCFullYear();
    const hours = date.getUTCHours();
    switch (c) {
        case 'y':
            if (run === 1) return String(year % 100);
            if (run === 2) return pad(year % 100, 2);
            return pad(year, run);
        case 'M': {
            const month = date.getUTCMonth();
            if (run === 1) return String(month + 1);
            if (run === 2) return pad(month + 1, 2);
            return run === 3 ? MONTHS[month].slice(0, 3) : MONTHS[month];
        }
        case 'd': {
            if (run === 1) return String(date.getUTCDate());
            if (run === 2) return pad(date.getUTCDate(), 2);
            const day = DAYS[date.getUTCDay()];
            return run === 3 ? day.slice(0, 3) : day;
        }
        case 'H':
            return run === 1 ? String(hours) : pad(hours, 2);
        case 'h': {
            const twelve = hours % 12 === 0 ? 12 : hours % 12;
            return run === 1 ? String(twelve) : pad(twelve, 2);
        }
        case 'm':
            return run === 1 ? String(date.getUTCMinutes()) : pad(date.getUTCMinutes(), 2);
        case 's':
            return run === 1 ? String(date.getUTCSeconds()) : pad(date.getUTCSeconds(), 2);
        case 'f':
        case 'F': {
            // A Date has milliseconds: the digits after them are 0
            const digits = (pad(date.getUTCMilliseconds(), 3) + '0000').slice(0, Math.min(run, 7));
            return c === 'f' ? digits : digits.replace(/0+$/, '');
        }
        case 't': {
            const designator = hours < 12 ? 'AM' : 'PM';
            return run === 1 ? designator[0] : designator;
        }
        case 'z':
            return run === 1 ? '+0' : run === 2 ? '+00' : '+00:00';
        case 'K':
            return 'Z'.repeat(run);
        default:
            return c.repeat(run);
    }
}

/** The whole days from the date to the start of today (UTC), as `(DateTime.Today - date).Days`. */
export function daysAgo(date: Date, now: Date): number {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.trunc((today - date.getTime()) / 86_400_000) + 0; // + 0: no -0
}
