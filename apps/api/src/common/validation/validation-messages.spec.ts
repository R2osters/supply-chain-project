import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { frenchValidationMessages, translateConstraint, validationExceptionFactory } from './validation-messages';

enum Mode {
  ROAD = 'ROAD',
  SEA = 'SEA',
}

class Line {
  @IsString()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class Everything {
  @IsEmail() email = 'not-an-email';
  @IsNotEmpty() label = '';
  @IsDefined() required: unknown = undefined;
  @MinLength(12) password = 'short';
  @MaxLength(3) code = 'TOOLONG';
  @MinLength(1) single = '';
  @Length(2, 4) between = 'x';
  @Min(0) budget = -5;
  @Max(1.5) share = 2;
  @IsInt() count = 1.5;
  @IsString() name: unknown = 42;
  @IsBoolean() flag: unknown = 'yes';
  @IsIn(['LOW', 'HIGH']) priority = 'MEDIUM';
  @IsEnum(Mode) mode = 'AIR';
  @IsNumber() amount: unknown = 'ten';
  @IsLatitude() latitude = 123;
  @IsLongitude() longitude = 500;
  @IsDateString() date = 'yesterday';
  @IsArray() list: unknown = 'a,b';
  @ArrayMinSize(2) few = ['a'];
  @ArrayMaxSize(1) many = ['a', 'b'];
  @IsObject() levers: unknown = 'none';
  @IsUUID() ref = 'nope';
  @Matches(/^\d{9}$/) mmsi = '123';
  @IsTimeZone() timezone = 'GMT+7';
  @IsString({ each: true }) tags: unknown = [1];
}

function messagesFor(target: object, options: Parameters<typeof validateSync>[1] = {}): string[] {
  return frenchValidationMessages(validateSync(target, options));
}

describe('frenchValidationMessages', () => {
  const messages = messagesFor(new Everything());
  const find = (field: string): string | undefined => messages.find((m) => m.includes(`« ${field} »`));

  it.each([
    ['email', '« email » doit être une adresse e-mail valide'],
    ['label', '« label » ne doit pas être vide'],
    ['required', '« required » est obligatoire'],
    ['password', '« password » doit contenir au moins 12 caractères'],
    ['code', '« code » doit contenir au plus 3 caractères'],
    ['single', '« single » doit contenir au moins 1 caractère'],
    ['between', '« between » doit contenir au moins 2 caractères'],
    ['budget', '« budget » doit valoir au moins 0'],
    ['share', '« share » doit valoir au plus 1.5'],
    ['count', '« count » doit être un nombre entier'],
    ['name', '« name » doit être un texte'],
    ['flag', '« flag » doit valoir true ou false'],
    ['priority', '« priority » doit valoir l’une des valeurs suivantes : LOW, HIGH'],
    ['mode', '« mode » doit valoir l’une des valeurs suivantes : ROAD, SEA'],
    ['amount', '« amount » doit être un nombre valide'],
    ['latitude', '« latitude » doit être une latitude valide (entre -90 et 90)'],
    ['longitude', '« longitude » doit être une longitude valide (entre -180 et 180)'],
    ['date', '« date » doit être une date au format ISO 8601 (par exemple 2026-01-31)'],
    ['list', '« list » doit être une liste'],
    ['few', '« few » doit contenir au moins 2 éléments'],
    ['many', '« many » doit contenir au plus 1 élément'],
    ['levers', '« levers » doit être un objet'],
    ['ref', '« ref » doit être un identifiant UUID valide'],
    ['mmsi', '« mmsi » n’a pas le format attendu'],
    ['timezone', '« timezone » doit être un fuseau horaire IANA valide (par exemple Africa/Accra)'],
    ['tags', 'Chaque valeur de « tags » doit être un texte'],
  ])('translates the default message for %s', (field, expected) => {
    expect(find(field)).toBe(expected);
  });

  it('leaves no English default behind', () => {
    for (const message of messages) {
      expect(message).not.toMatch(/\b(must|should)\b/);
    }
  });

  it('keeps a message the DTO wrote itself, word for word', () => {
    class Custom {
      @Matches(/^\d{7}$/, { message: 'Le numéro OMI doit comporter exactement 7 chiffres' })
      imoNumber = '12';

      // A French custom message that happens to start with the property name stays intact too.
      @Matches(/^\d{9}$/, { message: 'mmsi doit comporter exactement 9 chiffres' })
      mmsi = '12';
    }
    expect(messagesFor(new Custom())).toEqual([
      'Le numéro OMI doit comporter exactement 7 chiffres',
      'mmsi doit comporter exactement 9 chiffres',
    ]);
  });

  it('refuses unknown properties in French', () => {
    class Small {
      @IsOptional() @IsString() name?: string;
    }
    const target = Object.assign(new Small(), { role: 'SUPER_ADMIN' });
    expect(messagesFor(target, { whitelist: true, forbidNonWhitelisted: true })).toEqual([
      'Le champ « role » n’est pas autorisé',
    ]);
  });

  it('names nested fields by their path', () => {
    class Order {
      @ValidateNested({ each: true })
      @Type(() => Line)
      items: Line[] = [Object.assign(new Line(), { productId: 'p1', quantity: 0 })];
    }
    expect(messagesFor(new Order())).toEqual(['« items.0.quantity » doit valoir au moins 1']);
  });

  it('translates the nested-object type check', () => {
    expect(translateConstraint('nested property line must be either object or array', 'line', 'line')).toBe(
      '« line » doit être un objet ou une liste',
    );
  });

  it('does not mistake one property for another with a common prefix', () => {
    expect(translateConstraint('emailAddress must be an email', 'email', 'email')).toBeNull();
  });
});

describe('validationExceptionFactory', () => {
  class LoginBody {
    @IsEmail() email!: string;
    @IsString() @MaxLength(128) password!: string;
  }

  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: validationExceptionFactory,
  });

  it('answers the same 400 shape as Nest, with French messages', async () => {
    const attempt = pipe.transform({ email: 'nope', password: 7, extra: true }, { type: 'body', metatype: LoginBody });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    const error = (await attempt.catch((caught: unknown) => caught)) as BadRequestException;
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: [
        'Le champ « extra » n’est pas autorisé',
        '« email » doit être une adresse e-mail valide',
        '« password » doit contenir au plus 128 caractères',
        '« password » doit être un texte',
      ],
    });
  });
});
