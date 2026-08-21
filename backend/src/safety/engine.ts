/**
 * Sensitive-data detection (spec §5.4).
 *
 * The rule-based emergency/pharmacist-review escalation engine that used to
 * live in this file was removed by explicit store-owner decision: the chatbot
 * no longer detects emergencies, no longer routes anything to a human, and no
 * longer stops selling on any topic. This is the one safety check that
 * remains — it is unrelated to escalation and was never part of that removal.
 */

/** Card numbers, long ID numbers, and anything the customer labels a password. */
const CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/;
const CVV_PATTERN = /\bcvv\b[^\d]{0,10}\d{3,4}\b/i;
const PASSWORD_PATTERN = /\b(?:my )?password\b\s*(?:is|:)\s*\S+/i;
const CIVIL_ID_PATTERN = /\b\d{12}\b/; // Kuwaiti Civil ID length

export function containsSensitiveData(message: string): boolean {
  if (CVV_PATTERN.test(message) || PASSWORD_PATTERN.test(message)) return true;
  if (CIVIL_ID_PATTERN.test(message)) return true;
  if (CARD_PATTERN.test(message)) {
    // Avoid flagging ordinary long numbers like an order reference by requiring
    // a card-like grouping or an explicit mention.
    return /\b(card|visa|mastercard|knet|بطاقه|فيزا)\b/i.test(message) || /(?:\d{4}[ -]){3}\d{4}/.test(message);
  }
  return false;
}
