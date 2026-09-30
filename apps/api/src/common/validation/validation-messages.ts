import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * French messages for the global ValidationPipe.
 *
 * class-validator only speaks English ("email must be an email"), and the web shows the API's
 * `message` as is. Rather than repeating `{ message }` on every decorator of every DTO, the pipe's
 * `exceptionFactory` rewrites each *default* message into French here.
 *
 * A default message is recognised by its exact English wording, which also carries the
 * constraint's arguments ("must be shorter than or equal to 80 characters" gives 80). Anything
 * else is a message a DTO chose on purpose (`@Matches(re, { message })`) and is kept verbatim, so
 * a hand-written French message is never replaced by a generic one.
 *
 * The response keeps the shape Nest's default factory produces: a 400 whose `message` is a list
 * of strings, which the web joins into one line.
 */

type Rule = readonly [RegExp, (subject: string, match: RegExpMatchArray) => string];

/** French plural: 0 and 1 take the singular. */
const plural = (count: string, singular: string, pluralForm: string): string =>
  Math.abs(Number(count)) >= 2 ? pluralForm : singular;

/** What follows "<property> " in class-validator's default messages. */
const RULES: readonly Rule[] = [
  [/^must be an email$/, (s) => `${s} doit être une adresse e-mail valide`],
  [/^should not be empty$/, (s) => `${s} ne doit pas être vide`],
  [/^should not be null or undefined$/, (s) => `${s} est obligatoire`],
  [
    /^must be longer than or equal to (\d+) and shorter than or equal to (\d+) characters$/,
    (s, [, min, max]) => `${s} doit contenir entre ${min} et ${max} caractères`,
  ],
  [
    /^must be longer than or equal to (\d+) characters$/,
    (s, [, n]) => `${s} doit contenir au moins ${n} ${plural(n, 'caractère', 'caractères')}`,
  ],
  [
    /^must be shorter than or equal to (\d+) characters$/,
    (s, [, n]) => `${s} doit contenir au plus ${n} ${plural(n, 'caractère', 'caractères')}`,
  ],
  [/^must not be less than (.+)$/, (s, [, n]) => `${s} doit valoir au moins ${n}`],
  [/^must not be greater than (.+)$/, (s, [, n]) => `${s} doit valoir au plus ${n}`],
  [/^must be an integer number$/, (s) => `${s} doit être un nombre entier`],
  [/^must be a number conforming to the specified constraints$/, (s) => `${s} doit être un nombre valide`],
  [/^must be a number string$/, (s) => `${s} doit être un nombre`],
  [/^must be a positive number$/, (s) => `${s} doit être un nombre positif`],
  [/^must be a negative number$/, (s) => `${s} doit être un nombre négatif`],
  [/^must be a string$/, (s) => `${s} doit être un texte`],
  [/^must be a boolean value$/, (s) => `${s} doit valoir true ou false`],
  [
    /^must be one of the following values: (.*)$/,
    (s, [, values]) => `${s} doit valoir l’une des valeurs suivantes : ${values}`,
  ],
  [/^must be a latitude string or number$/, (s) => `${s} doit être une latitude valide (entre -90 et 90)`],
  [/^must be a longitude string or number$/, (s) => `${s} doit être une longitude valide (entre -180 et 180)`],
  [
    /^must be a valid ISO 8601 date string$/,
    (s) => `${s} doit être une date au format ISO 8601 (par exemple 2026-01-31)`,
  ],
  [/^must be a Date instance$/, (s) => `${s} doit être une date valide`],
  [/^must be an array$/, (s) => `${s} doit être une liste`],
  [
    /^must contain at least (\d+) elements$/,
    (s, [, n]) => `${s} doit contenir au moins ${n} ${plural(n, 'élément', 'éléments')}`,
  ],
  [
    /^must contain no more than (\d+) elements$/,
    (s, [, n]) => `${s} doit contenir au plus ${n} ${plural(n, 'élément', 'éléments')}`,
  ],
  [/^must be an object$/, (s) => `${s} doit être un objet`],
  [/^must be a UUID$/, (s) => `${s} doit être un identifiant UUID valide`],
  [/^must match .+ regular expression$/, (s) => `${s} n’a pas le format attendu`],
  [
    /^must be a valid IANA time-zone$/,
    (s) => `${s} doit être un fuseau horaire IANA valide (par exemple Africa/Accra)`,
  ],
  [/^must be a URL address$/, (s) => `${s} doit être une URL valide`],
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The French version of one class-validator message, or null when the message is not one of
 * class-validator's defaults (a custom message, which the caller keeps as written).
 */
export function translateConstraint(message: string, property: string, path: string): string | null {
  const field = `« ${path} »`;
  const p = escapeRegExp(property);

  if (new RegExp(`^property ${p} should not exist$`).test(message)) {
    return `Le champ ${field} n’est pas autorisé`;
  }
  if (message === 'an unknown value was passed to the validate function') {
    return 'Le contenu de la requête n’est pas valide';
  }

  const nested = message.match(new RegExp(`^(each value in )?nested property ${p} must be either object or array$`));
  if (nested) return `${nested[1] ? `Chaque valeur de ${field}` : field} doit être un objet ou une liste`;

  if (new RegExp(`^(each value in )?All ${p}'s elements must be unique$`).test(message)) {
    return `Les éléments de ${field} doivent être uniques`;
  }

  const head = message.match(new RegExp(`^(each value in )?${p} (.+)$`));
  if (!head) return null;
  const subject = head[1] ? `Chaque valeur de ${field}` : field;
  for (const [pattern, build] of RULES) {
    const match = head[2].match(pattern);
    if (match) return build(subject, match);
  }
  return null;
}

/**
 * Flattens validation errors into French messages, depth first, naming nested fields by their
 * path (`items.0.quantity`) the way Nest's default factory does.
 */
export function frenchValidationMessages(errors: ValidationError[], parentPath?: string): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      const french = translateConstraint(message, error.property, path);
      if (french) messages.push(french);
      else messages.push(parentPath ? `« ${parentPath} » : ${message}` : message);
    }
    if (error.children?.length) messages.push(...frenchValidationMessages(error.children, path));
  }
  return messages;
}

/** `exceptionFactory` for the global ValidationPipe: same 400 shape, French messages. */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  return new BadRequestException(frenchValidationMessages(errors));
}
