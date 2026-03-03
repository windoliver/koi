import { describe, expect, test } from "bun:test";
import {
  createAllDetectors,
  createCreditCardDetector,
  createEmailDetector,
  createIPDetector,
  createMACDetector,
  createPhoneDetector,
  createSSNDetector,
  createURLDetector,
} from "./detectors.js";

describe("createEmailDetector", () => {
  const detector = createEmailDetector();

  test("detects simple email addresses", () => {
    const matches = detector.detect("Contact us at user@example.com for info");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("user@example.com");
    expect(matches[0]?.kind).toBe("email");
  });

  test("detects multiple emails", () => {
    const matches = detector.detect("a@b.com and c@d.org");
    expect(matches).toHaveLength(2);
  });

  test("detects emails with dots and plus signs", () => {
    const matches = detector.detect("first.last+tag@sub.example.co.uk");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("first.last+tag@sub.example.co.uk");
  });

  test("returns empty for text without @", () => {
    const matches = detector.detect("no email here");
    expect(matches).toHaveLength(0);
  });

  test("returns empty for invalid email-like strings", () => {
    const matches = detector.detect("@nousername.com");
    expect(matches).toHaveLength(0);
  });
});

describe("createCreditCardDetector", () => {
  const detector = createCreditCardDetector();

  test("detects standard card numbers with spaces", () => {
    const matches = detector.detect("Card: 4532 0151 2345 6789");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("credit_card");
  });

  test("detects card numbers with dashes", () => {
    const matches = detector.detect("Card: 4532-0151-2345-6789");
    expect(matches).toHaveLength(1);
  });

  test("detects card numbers without separators", () => {
    const matches = detector.detect("Card: 4532015123456789");
    expect(matches).toHaveLength(1);
  });

  test("rejects numbers that fail Luhn check", () => {
    const matches = detector.detect("Not a card: 1234 5678 9012 3456");
    expect(matches).toHaveLength(0);
  });

  test("returns empty for text without digit clusters", () => {
    const matches = detector.detect("no cards here");
    expect(matches).toHaveLength(0);
  });
});

describe("createIPDetector", () => {
  const detector = createIPDetector();

  test("detects standard IPv4 addresses", () => {
    const matches = detector.detect("Server at 192.168.1.1");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("192.168.1.1");
    expect(matches[0]?.kind).toBe("ip");
  });

  test("detects multiple IPs", () => {
    const matches = detector.detect("10.0.0.1 and 172.16.0.1");
    expect(matches).toHaveLength(2);
  });

  test("validates octet ranges", () => {
    const matches = detector.detect("Invalid: 999.999.999.999");
    expect(matches).toHaveLength(0);
  });

  test("detects boundary values", () => {
    const matches = detector.detect("Address: 0.0.0.0 and 255.255.255.255");
    expect(matches).toHaveLength(2);
  });

  test("returns empty for text without dots", () => {
    const matches = detector.detect("no ips here");
    expect(matches).toHaveLength(0);
  });
});

describe("createMACDetector", () => {
  const detector = createMACDetector();

  test("detects colon-separated MAC addresses", () => {
    const matches = detector.detect("MAC: aa:bb:cc:dd:ee:ff");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("aa:bb:cc:dd:ee:ff");
    expect(matches[0]?.kind).toBe("mac");
  });

  test("detects dash-separated MAC addresses", () => {
    const matches = detector.detect("MAC: AA-BB-CC-DD-EE-FF");
    expect(matches).toHaveLength(1);
  });

  test("detects mixed-case MAC addresses", () => {
    const matches = detector.detect("MAC: aA:bB:cC:dD:eE:fF");
    expect(matches).toHaveLength(1);
  });

  test("returns empty for text without colons or dashes", () => {
    const matches = detector.detect("no macs here");
    expect(matches).toHaveLength(0);
  });
});

describe("createURLDetector", () => {
  const detector = createURLDetector();

  test("detects https URLs", () => {
    const matches = detector.detect("Visit https://example.com/page");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("https://example.com/page");
    expect(matches[0]?.kind).toBe("url");
  });

  test("detects http URLs", () => {
    const matches = detector.detect("Visit http://example.com");
    expect(matches).toHaveLength(1);
  });

  test("detects www URLs", () => {
    const matches = detector.detect("Visit www.example.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("www.example.com");
  });

  test("strips trailing punctuation", () => {
    const matches = detector.detect("See https://example.com/page.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("https://example.com/page");
  });

  test("strips trailing comma and paren", () => {
    const matches = detector.detect("(see https://example.com/page),");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("https://example.com/page");
  });

  test("returns empty for text without URL signals", () => {
    const matches = detector.detect("no urls here");
    expect(matches).toHaveLength(0);
  });
});

describe("createSSNDetector", () => {
  const detector = createSSNDetector();

  test("detects standard SSN format", () => {
    const matches = detector.detect("SSN: 123-45-6789");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("123-45-6789");
    expect(matches[0]?.kind).toBe("ssn");
  });

  test("detects multiple SSNs", () => {
    const matches = detector.detect("SSN 123-45-6789 and 234-56-7890");
    expect(matches).toHaveLength(2);
  });

  test("rejects area 000", () => {
    const matches = detector.detect("Invalid: 000-12-3456");
    expect(matches).toHaveLength(0);
  });

  test("rejects area 666", () => {
    const matches = detector.detect("Invalid: 666-12-3456");
    expect(matches).toHaveLength(0);
  });

  test("rejects area 900-999", () => {
    const matches = detector.detect("Invalid: 900-12-3456");
    expect(matches).toHaveLength(0);
  });

  test("rejects group 00", () => {
    const matches = detector.detect("Invalid: 123-00-4567");
    expect(matches).toHaveLength(0);
  });

  test("rejects serial 0000", () => {
    const matches = detector.detect("Invalid: 123-45-0000");
    expect(matches).toHaveLength(0);
  });

  test("returns empty for text without dash-digit pattern", () => {
    const matches = detector.detect("no ssn here");
    expect(matches).toHaveLength(0);
  });
});

describe("createPhoneDetector", () => {
  const detector = createPhoneDetector();

  test("detects US phone with dashes", () => {
    const matches = detector.detect("Call 555-123-4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("555-123-4567");
    expect(matches[0]?.kind).toBe("phone");
  });

  test("detects US phone with dots", () => {
    const matches = detector.detect("Call 555.123.4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("555.123.4567");
  });

  test("detects US phone with parenthesized area code", () => {
    const matches = detector.detect("Call (555) 123-4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("(555) 123-4567");
  });

  test("detects phone with country code", () => {
    const matches = detector.detect("Call +1-555-123-4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("+1-555-123-4567");
  });

  test("detects phone with country code and parens", () => {
    const matches = detector.detect("Call +1 (555) 123-4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("+1 (555) 123-4567");
  });

  test("detects multiple phone numbers", () => {
    const matches = detector.detect("555-123-4567 or 555-987-6543");
    expect(matches).toHaveLength(2);
  });

  test("returns empty for text without phone patterns", () => {
    const matches = detector.detect("no phones here");
    expect(matches).toHaveLength(0);
  });

  test("returns empty for too few digits", () => {
    const matches = detector.detect("555-12-4567");
    expect(matches).toHaveLength(0);
  });
});

describe("createAllDetectors", () => {
  test("returns 7 detectors", () => {
    const detectors = createAllDetectors();
    expect(detectors).toHaveLength(7);
  });

  test("each detector has name and kind", () => {
    const detectors = createAllDetectors();
    for (const d of detectors) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.kind).toBe("string");
      expect(typeof d.detect).toBe("function");
    }
  });
});
