// PE-9: an outlet's timezone drives its "today" (shifts, reports, dashboard)
// and every receipt time, so it must be a real IANA zone in the tenant's own
// country - an Australian outlet saved as Asia/Kolkata is 4.5-5.5 h off.
import { BadRequestException } from '@nestjs/common'

function isRealTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function timezoneFitsCountry(timezone: string, country: 'IN' | 'AU'): boolean {
  if (!isRealTimezone(timezone)) return false
  return country === 'IN' ? timezone === 'Asia/Kolkata' || timezone === 'Asia/Calcutta' : timezone.startsWith('Australia/')
}

/** 400 validation_failed unless every timezone is a real zone in the country. */
export function assertTimezonesFitCountry(timezones: readonly string[], country: 'IN' | 'AU'): void {
  const wrong = timezones.find((timezone) => !timezoneFitsCountry(timezone, country))
  if (wrong !== undefined) {
    const where = country === 'IN' ? 'India (Asia/Kolkata)' : 'Australia (an Australia/... timezone)'
    throw new BadRequestException({ code: 'validation_failed', message: `Timezone "${wrong}" is not a timezone in ${where}` })
  }
}
