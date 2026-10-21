import { type EntityConfig, EntityConfigureOf, entityDefinition } from './entity.js';
import {
    AmbiguousProfileConfigurationError,
    DistributedKeyAssignedToMultipleEntitiesError,
    DistributedMapError,
} from './errors.js';
import { parseExpression } from './expressions/parser.js';
import { type MappingRule, type ModelRef, modelName, ProfileOf, type ProfileLike, profileDefinition } from './profile.js';

/** A problem found by {@link validateProfiles} or {@link validateEntities}. */
export interface ValidationProblem {
    /** The profile or entity configuration: its class name, or what it maps or configures. */
    readonly source: string;
    /** The property of the rule or of the entity, or `null` when the problem is the whole profile or configuration. */
    readonly property: string | null;
    /** The invalid expression or exposed name, or `null`. */
    readonly expression: string | null;
    /** What is wrong. */
    readonly message: string;
}

/** One line: `OrderProfile.userEmail: Expression 'Email:' is invalid: ...`. */
export function describeProblem(problem: ValidationProblem): string {
    return `${problem.property === null ? problem.source : `${problem.source}.${problem.property}`}: ${problem.message}`;
}

/** Thrown by {@link validateOrThrow}, with every problem found. */
export class NfxMapValidationError extends DistributedMapError {
    constructor(readonly problems: readonly ValidationProblem[]) {
        super(`nfxmap found ${problems.length} problem(s):${problems.map(p => `\n - ${describeProblem(p)}`).join('')}`);
    }
}

/**
 * Checks profiles and entity configurations at startup (jfxmap's `JfxMapValidator`, FxMap.Analyzers' `OFX001` at run
 * time), for the mistakes the mapper or a handler would otherwise report on the first request:
 *
 * ```ts
 * validateOrThrow({ profiles: [new OrderProfile()], entities: [new UserConfig()] });
 * ```
 *
 * A profile is checked by declaring its rules, parsing the fixed expression of each rule (a `null` or blank expression
 * is not parsed, and the expressions of a conditional rule are functions, so they are skipped), and looking for rules
 * whose keys fill each other. Two profiles for the same model are reported. An entity configuration is checked by
 * declaring it (id and key declared, exposed names unique) and by checking that each exposed name is a plain name an
 * expression can use; two configurations for the same key are reported.
 */
export function validateOrThrow(options: {
    readonly profiles?: Iterable<ProfileLike<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    readonly entities?: Iterable<EntityConfig<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}): void {
    const problems = [...validateProfiles(options.profiles ?? []), ...validateEntities(options.entities ?? [])];
    if (problems.length > 0) throw new NfxMapValidationError(problems);
}

/** The problems of the profiles; empty when they are all valid. */
export function validateProfiles(profiles: Iterable<ProfileLike<any>>): ValidationProblem[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const problems: ValidationProblem[] = [];
    const models = new Map<ModelRef, string>();
    for (const profile of profiles) {
        if (profile === null || profile === undefined) throw new TypeError('A profile is required.');
        const source = profileSource(profile);
        let rules: readonly MappingRule[];
        let model: ModelRef;
        try {
            const definition = profileDefinition(profile);
            rules = definition.rules;
            model = definition.model;
        } catch (error) {
            problems.push({ source, property: null, expression: null, message: messageOf(error) });
            continue;
        }
        if (models.has(model)) {
            problems.push({
                source, property: null, expression: null,
                message: new AmbiguousProfileConfigurationError(nameOf(model)).message,
            });
        } else {
            models.set(model, source);
        }
        for (const rule of rules) {
            const expression = rule.expression;
            if (rule.conditional !== null || expression === null || expression.trim() === '') continue;
            const error = expressionError(expression);
            if (error !== null) problems.push({
                source, property: rule.targetProperty, expression,
                message: `Expression '${expression}' is invalid: ${error}`,
            });
        }
        for (const cycle of cycles(rules)) problems.push({
            source, property: cycle[0], expression: null,
            message: `The keys of ${cycle.join(', ')} are filled by each other: none of these rules can run first.`,
        });
    }
    return problems;
}

/** The problems of the entity configurations; empty when they are all valid. */
export function validateEntities(configurations: Iterable<EntityConfig<any>>): ValidationProblem[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const problems: ValidationProblem[] = [];
    const entitiesByKey = new Map<string, { readonly sources: string[]; readonly names: string[] }>();
    for (const configuration of configurations) {
        if (configuration === null || configuration === undefined)
            throw new TypeError('An entity configuration is required.');
        let source = configuration instanceof EntityConfigureOf ? configuration.constructor.name : 'entity';
        try {
            const definition = entityDefinition(configuration);
            if (!(configuration instanceof EntityConfigureOf)) source = definition.name;
            const entities = entitiesByKey.get(definition.key) ?? { sources: [], names: [] };
            entities.sources.push(source);
            entities.names.push(definition.name);
            entitiesByKey.set(definition.key, entities);
            for (const [name, property] of definition.exposedNames) {
                if (!isPlainName(name)) problems.push({
                    source, property, expression: name,
                    message: `The exposed name '${name}' cannot be used in an expression: it must be a name such as `
                        + 'UserEmail.',
                });
            }
        } catch (error) {
            problems.push({ source, property: null, expression: null, message: messageOf(error) });
        }
    }
    for (const [key, { sources, names }] of entitiesByKey) {
        if (names.length < 2) continue;
        const message = new DistributedKeyAssignedToMultipleEntitiesError(key, names).message;
        for (const source of sources.slice(1)) problems.push({ source, property: null, expression: null, message });
    }
    return problems;
}

/** Whether an expression made of `name` alone reads the property `name`. */
export function isPlainName(name: string): boolean {
    try {
        const node = parseExpression(name);
        return node.kind === 'Property' && node.name === name && !node.isNullSafe;
    } catch {
        return false;
    }
}

/** Why the expression does not parse, or `null` when it does. */
export function expressionError(expression: string): string | null {
    try {
        parseExpression(expression);
        return null;
    } catch (error) {
        return messageOf(error);
    }
}

function profileSource(profile: ProfileLike<unknown>): string {
    if (profile instanceof ProfileOf) return profile.constructor.name;
    try {
        return `profile of ${nameOf(profile.model)}`;
    } catch {
        return 'profile';
    }
}

function nameOf(model: ModelRef): string {
    try {
        return modelName(model);
    } catch {
        return String(model);
    }
}

// The rules whose keys are filled by each other (a's key is b's target, b's key is a's target...), by target
function cycles(rules: readonly MappingRule[]): string[][] {
    const byTarget = new Map(rules.map(rule => [rule.targetProperty, rule] as const));
    const found: string[][] = [];
    const reported = new Set<string>();
    for (const start of rules) {
        const path: string[] = [];
        let rule: MappingRule | undefined = start;
        while (rule !== undefined && !path.includes(rule.targetProperty)) {
            path.push(rule.targetProperty);
            const next = byTarget.get(rule.selectorProperty);
            rule = next === rule ? undefined : next;
        }
        if (rule === undefined) continue;
        const cycle = path.slice(path.indexOf(rule.targetProperty));
        if (cycle.some(target => reported.has(target))) continue;
        cycle.forEach(target => reported.add(target));
        found.push(cycle);
    }
    return found;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
