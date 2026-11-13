// GST state codes (the first two digits of every GSTIN). A restaurant's
// supply is made where the restaurant is (IGST Act s.12(2)(a)/(3)), which is
// the state the seller's GSTIN is registered in - so the invoice's "place of
// supply" is read straight off the GSTIN, no extra field to keep in sync.
const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}

/** "Karnataka (29)" for a GSTIN starting 29; null when the number doesn't start with a known state code. */
export function placeOfSupplyFromGstin(gstin: string | null): string | null {
  const code = gstin?.trim().slice(0, 2) ?? ''
  const state = GST_STATES[code]
  return state ? `${state} (${code})` : null
}

/** SAC for restaurant services (Notification 11/2017-CT(Rate), heading 9963). */
export const RESTAURANT_SAC = '996331'
