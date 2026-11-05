// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: gjs -m test/totp.test.js

import { decode as decodeBase32, isValid as isValidBase32 } from '../lib/base32.js';
import { generateHOTP } from '../lib/hotp.js';
import {
    generateTOTP,
    generateTOTPWithOffset,
    getTimeCounter,
    getTimeRemaining,
} from '../lib/totp.js';

let passed = 0;
let failed = 0;
let total = 0;

function assertEqual(actual, expected, message) {
    total++;
    if (actual === expected) {
        passed++;
        print(`  PASS ${message}`);
    } else {
        failed++;
        print(`  FAIL ${message}: expected "${expected}", got "${actual}"`);
    }
}

function assertThrows(fn, message) {
    total++;
    try {
        fn();
        failed++;
        print(`  FAIL ${message}: expected an error`);
    } catch (error) {
        passed++;
        print(`  PASS ${message}`);
    }
}

print('\n--- RFC 4648 Base32 ---');
assertEqual(new TextDecoder().decode(decodeBase32('JBSWY3DPEE======')), 'Hello!', 'decodes padded Base32');
assertEqual(new TextDecoder().decode(decodeBase32('jbsw-y3dp-ee')), 'Hello!', 'accepts lowercase and separators');
assertEqual(decodeBase32('').length, 0, 'decodes empty input to empty bytes');
assertEqual(isValidBase32('JBSWY3DPEHPK3PXP'), true, 'validates a Base32 secret');
assertEqual(isValidBase32('not-valid!'), false, 'rejects invalid characters');
assertEqual(isValidBase32('JBSWY3DPEE='), false, 'rejects invalid padding');
assertEqual(isValidBase32('MZ'), false, 'rejects non-zero trailing bits');
assertThrows(() => decodeBase32('A'), 'rejects impossible Base32 lengths');
assertThrows(() => decodeBase32('JBS= WY3D'), 'rejects embedded padding');

print('\n--- RFC 4226 HOTP ---');
const hotpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const hotpVectors = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
];
for (const [counter, expected] of hotpVectors.entries()) {
    assertEqual(
        generateHOTP({ secret: hotpSecret, counter }),
        expected,
        `matches RFC vector for counter ${counter}`,
    );
}
assertThrows(() => generateHOTP({ secret: hotpSecret, counter: -1 }), 'rejects negative counters');
assertThrows(() => generateHOTP({ secret: hotpSecret, counter: 1.5 }), 'rejects fractional counters');
assertThrows(() => generateHOTP({ secret: hotpSecret, counter: 0, digits: 6.5 }), 'rejects fractional digits');
assertThrows(() => generateHOTP({ secret: 'A', counter: 0 }), 'rejects secrets that decode to no bytes');

print('\n--- RFC 6238 TOTP ---');
const sha1Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const sha256Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const sha512Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';
const vectors = [
    { algorithm: 'SHA1', secret: sha1Secret, digits: 6, time: 59, expected: '287082' },
    { algorithm: 'SHA1', secret: sha1Secret, digits: 6, time: 1111111109, expected: '081804' },
    { algorithm: 'SHA1', secret: sha1Secret, digits: 6, time: 1111111111, expected: '050471' },
    { algorithm: 'SHA1', secret: sha1Secret, digits: 6, time: 1234567890, expected: '005924' },
    { algorithm: 'SHA1', secret: sha1Secret, digits: 6, time: 2000000000, expected: '279037' },
    { algorithm: 'SHA256', secret: sha256Secret, digits: 8, time: 59, expected: '46119246' },
    { algorithm: 'SHA256', secret: sha256Secret, digits: 8, time: 1111111109, expected: '68084774' },
    { algorithm: 'SHA256', secret: sha256Secret, digits: 8, time: 1111111111, expected: '67062674' },
    { algorithm: 'SHA256', secret: sha256Secret, digits: 8, time: 1234567890, expected: '91819424' },
    { algorithm: 'SHA256', secret: sha256Secret, digits: 8, time: 2000000000, expected: '90698825' },
    { algorithm: 'SHA512', secret: sha512Secret, digits: 8, time: 59, expected: '90693936' },
    { algorithm: 'SHA512', secret: sha512Secret, digits: 8, time: 1111111109, expected: '25091201' },
    { algorithm: 'SHA512', secret: sha512Secret, digits: 8, time: 1111111111, expected: '99943326' },
    { algorithm: 'SHA512', secret: sha512Secret, digits: 8, time: 1234567890, expected: '93441116' },
    { algorithm: 'SHA512', secret: sha512Secret, digits: 8, time: 2000000000, expected: '38618901' },
];

for (const { algorithm, secret, digits, time, expected } of vectors) {
    assertEqual(
        generateTOTP({ secret, algorithm, digits, time }),
        expected,
        `matches ${algorithm} RFC vector at ${time}`,
    );
}

assertEqual(getTimeCounter(59, 30), 1, 'calculates the TOTP time counter');
assertEqual(getTimeCounter(60, 60), 1, 'supports a 60-second period');
assertEqual(getTimeRemaining(30) >= 1, true, 'returns at least one second remaining');
assertEqual(
    generateTOTPWithOffset({ secret: sha1Secret, time: 59 }, -1),
    generateHOTP({ secret: sha1Secret, counter: 0 }),
    'generates an adjacent time window',
);
assertThrows(() => getTimeCounter(0, 0), 'rejects a zero period');
assertThrows(() => getTimeCounter(-1, 30), 'rejects a negative time counter');
assertThrows(
    () => generateTOTPWithOffset({ secret: sha1Secret, time: 59 }, -2),
    'rejects an offset before the Unix epoch',
);

print('\n------------------------------');
print(`Results: ${passed}/${total} passed, ${failed} failed`);
print('------------------------------\n');

if (failed > 0) {
    imports.system.exit(1);
}
