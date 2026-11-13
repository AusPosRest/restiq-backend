import { Matches } from 'class-validator'

/** SE-19: a free-text name must have at least one non-space character - "   " is not a name. */
export const NotBlank = (): PropertyDecorator => Matches(/\S/, { message: '$property must not be blank' })
