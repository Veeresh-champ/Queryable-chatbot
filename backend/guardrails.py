"""Input and output guardrails shared by every chat path.

* Input checks: size limits, control characters and obvious prompt-injection
  or destructive-intent phrases.
* Output checks: PII masking for database results before they reach an LLM
  or the browser.

These checks complement, not replace, the query validator in
``backend/validator.py``, which remains the authority on what may run
against MongoDB.
"""

import re

from backend.config import settings

INJECTION_PATTERNS = [
    r"ignore (all |any )?(the )?(previous|prior|above) (instructions|rules|prompts?)",
    r"disregard (all |any )?(the )?(previous|prior|above|system) (instructions|rules|prompts?)",
    r"(reveal|print|show|repeat) (me )?(your|the) (system|hidden) prompt",
    r"you are now (in )?(developer|dan|jailbreak) mode",
    r"\b(api[_ ]?key|secret[_ ]?key|password hash|connection string)\b",
    # Paraphrases: "set aside / forget / override earlier guidance", "output the hidden instructions"
    r"\b(ignore|disregard|forget|set aside|override|bypass|skip)\b.{0,30}\b(earlier|previous|prior|above|original|system|your)\b.{0,20}\b(instructions?|guidance|rules|prompts?|directives?)\b",
    r"\b(output|reveal|print|show|repeat|leak|dump)\b.{0,30}\b(hidden|system|internal|secret|initial)\b.{0,15}\b(instructions?|prompts?|rules)\b",
]

DESTRUCTIVE_PATTERNS = [
    r"\b(drop|truncate)\b.{0,40}\b(database|collection|table)s?\b",
    r"\b(delete|remove|wipe|erase)\s+(all\s+)?(the\s+)?(records|documents|rows|data|collection)\b",
    r"\b(update|modify|insert|overwrite)\s+(the\s+)?(records|documents|rows|database|collection)\b",
    r"\$where|\$function|\$out\b|\$merge\b|db\.\w+\.(drop|remove|delete|update|insert)",
]

_INJECTION_RE = [re.compile(p, re.IGNORECASE) for p in INJECTION_PATTERNS]
_DESTRUCTIVE_RE = [re.compile(p, re.IGNORECASE) for p in DESTRUCTIVE_PATTERNS]
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class GuardrailViolation(ValueError):
    """Raised when a request must be refused before any model or tool runs."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def check_question(question):
    """Validate and normalise a user question.

    Returns the cleaned question or raises ``GuardrailViolation``.
    """

    text = _CONTROL_CHARS.sub("", str(question or "")).strip()

    if not text:
        raise GuardrailViolation("empty", "Please enter a question.")

    if len(text) > settings.max_question_chars:
        raise GuardrailViolation(
            "too_long",
            f"Questions are limited to {settings.max_question_chars} characters.",
        )

    if any(pattern.search(text) for pattern in _INJECTION_RE):
        raise GuardrailViolation(
            "prompt_injection",
            "This request tries to change the assistant's instructions or "
            "obtain secrets, so it was not processed.",
        )

    if any(pattern.search(text) for pattern in _DESTRUCTIVE_RE):
        raise GuardrailViolation(
            "write_operation",
            "The chatbot has read-only access to the data. It cannot delete, "
            "update, insert or drop records.",
        )

    return text


# --------------------------------------------------
# PII masking
# --------------------------------------------------

PII_FIELD_PATTERN = re.compile(
    r"(e[-_\s]?mail|phone|mobile|contact[-_\s]?(number|no|person|name)|address|street|zip|postal|"
    r"password|passwd|ssn|social_security|national_id|passport|"
    r"credit_card|card_number|iban|account_number|dob|date_of_birth|birth_date|birthday|"
    r"(^|[-_\s])(tel|telephone|cell[-_\s]?(no|number|phone)?|mob[-_\s]?no|whatsapp|fax)($|[-_\s])|"
    r"(^|[-_\s])mail([-_\s]?id)?($|[-_\s])|linkedin|"
    r"(first|last|middle|full|given|family|person|employee|customer)[-_\s]?name|surname)",
    re.IGNORECASE,
)

# Yes/no columns about a PII-sounding topic ("credit_card_accepted",
# "mobile_app_yes_no") hold no personal data.
NOT_PII_SUFFIX = re.compile(r"(_yes_no|_accepted|_flag|_enabled|_available)$", re.IGNORECASE)


def is_pii_field(name):
    """True when a field name (any part of a dotted path) looks like personal data."""

    for part in str(name or "").split("."):
        if PII_FIELD_PATTERN.search(part) and not NOT_PII_SUFFIX.search(part):
            return True
    return False


EMAIL_VALUE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_VALUE = re.compile(r"(?<!\d)(\+?\d[\d\s().-]{8,}\d)(?!\d)")
# Phone numbers inside free text or unnamed fields: international (+...) or
# (555) 123-4567 style. Plain digit runs and ISO dates are left alone.
PHONE_IN_TEXT = re.compile(r"(?<![\w+])(\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s?\d{3}[-\s]\d{4})(?!\w)")


def _mask(value):
    text = str(value)
    if "***" in text:  # already masked
        return text
    if EMAIL_VALUE.fullmatch(text):
        name, _, domain = text.partition("@")
        return f"{name[:1]}***@{domain}"
    if len(text) <= 4:
        return "***"
    return f"{text[:2]}***{text[-2:]}"


def _redact_value(key, value):
    if isinstance(value, dict):
        return {k: _redact_value(k, v) for k, v in value.items()}

    if isinstance(value, list):
        return [_redact_value(key, item) for item in value]

    if key and is_pii_field(key) and value not in (None, ""):
        return _mask(value)

    if isinstance(value, str):
        value = EMAIL_VALUE.sub(lambda m: _mask(m.group(0)), value)
        value = PHONE_IN_TEXT.sub(lambda m: _mask(m.group(0)), value)

    return value


def redact_pii(records):
    """Mask personal data in MongoDB results (by field name, and e-mail/phone values)."""

    if not settings.redact_pii:
        return records

    return _redact_value(None, records)
