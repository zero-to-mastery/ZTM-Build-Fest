// Usernames and passwords for signing in (ADR 0018, #557/#558): the rules
// both the browser and the service apply, kept in one place so they can't
// drift. Pure functions only: no network, no storage, no cryptography (the
// password's keys come from account-vault.js derivePasswordKeys).
//
// The service imports this module too (server/account-sign-in.mjs), so it
// must stay free of browser-only APIs.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 1024;

/** One line of plain guidance, shown wherever a new password is chosen. */
export const PASSWORD_GUIDANCE = "Use at least 10 characters. A few unrelated words works well.";
export const USERNAME_GUIDANCE = "3 to 32 letters, numbers, dots, dashes or underscores.";

const USERNAME = /^[a-z0-9._-]+$/;

/**
 * The canonical form of a username, or null when it isn't one. Usernames are
 * case-insensitive: "Sam.Lee" and "sam.lee" are the same account. NFKC folds
 * compatibility forms (full-width letters) first, then only ASCII letters,
 * digits, dots, dashes and underscores are allowed, which also keeps
 * look-alike letters from other scripts out of names people compare by eye.
 */
export function normalizeUsername(value) {
  if (typeof value !== "string" || value.length > 4 * USERNAME_MAX_LENGTH) return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length < USERNAME_MIN_LENGTH || normalized.length > USERNAME_MAX_LENGTH) return null;
  return USERNAME.test(normalized) ? normalized : null;
}

/** Plain words for a username that isn't one, or null when it's fine. */
export function usernameProblem(value) {
  return normalizeUsername(value) ? null : `Choose a username of ${USERNAME_GUIDANCE.charAt(0).toLowerCase()}${USERNAME_GUIDANCE.slice(1)}`;
}

/**
 * Plain words for a password below Kin's floor, or null when it's fine. The
 * floor: at least 10 characters (code points, so emoji count once), not one
 * character repeated, not the username, and not in a short list of the most
 * common passwords. It is a floor against the guesses tried first, not a
 * strength meter: length matters most, which the guidance says.
 */
export function passwordProblem(password, { username = null } = {}) {
  if (typeof password !== "string" || !password.length) return "Enter a password.";
  if (password.length > PASSWORD_MAX_LENGTH) return "That password is too long. Use at most 1,024 characters.";
  const characters = [...password];
  if (characters.length < PASSWORD_MIN_LENGTH) return PASSWORD_GUIDANCE;
  const folded = password.normalize("NFKC").toLowerCase();
  const name = typeof username === "string" ? normalizeUsername(username) : null;
  if (new Set(characters).size === 1 || COMMON_PASSWORDS.has(folded) || (name && folded.replaceAll(/\s/g, "") === name))
    return "That password is too easy to guess. A few unrelated words works well.";
  return null;
}

// The most common passwords of 10 or more characters (shorter ones are
// already refused by length), lower-cased. Drawn from public breach
// frequency lists; it only has to stop the first guesses an attacker makes.
export const COMMON_PASSWORDS = new Set([
  "1234567890", "0123456789", "0987654321", "9876543210", "1111111111", "0000000000",
  "1234512345", "1122334455", "1212121212", "1231231234", "12345678910", "123456789a",
  "a123456789", "1234567890a", "1234567891", "12345678901", "123456789012", "1234567890123",
  "qwertyuiop", "qwertyuiop1", "qwertyuiop123", "1qaz2wsx3edc", "1q2w3e4r5t", "1q2w3e4r5t6y",
  "q1w2e3r4t5", "q1w2e3r4t5y6", "zaq12wsxcde3", "zxcvbnm123", "asdfghjkl1", "asdfghjkl123",
  "qwerty1234", "qwerty12345", "qwerty123456", "qwertyqwerty", "asdfasdfasdf", "abcdefghij",
  "abcdefghijk", "abcdefghijkl", "abcd123456", "abc1234567", "abcdef123456", "abcabcabcabc",
  "password12", "password123", "password1234", "password12345", "password1!", "password123!",
  "passw0rd123", "p@ssw0rd123", "p@ssword123", "password2020", "password2021", "password2022",
  "password2023", "password2024", "password2025", "password2026", "mypassword", "mypassword1",
  "mypassword123", "newpassword", "newpassword1", "passwordpassword", "thisismypassword", "yourpassword",
  "changeme123", "letmein123", "letmeinplease", "welcome123", "welcome1234", "welcometo123",
  "iloveyou12", "iloveyou123", "iloveyou1234", "iloveyouforever", "iloveyoubaby", "iloveyousomuch",
  "loveyou123", "lovelove123", "princess123", "sunshine123", "sunshine12", "football123",
  "football12", "baseball123", "basketball", "basketball1", "basketball123", "soccer1234",
  "superman123", "batman12345", "spiderman1", "spiderman123", "starwars123", "pokemon123",
  "minecraft1", "minecraft123", "fortnite123", "liverpool1", "liverpool123", "chelsea123",
  "manchester", "manchester1", "arsenal123", "barcelona1", "realmadrid", "juventus123",
  "dragon1234", "monkey1234", "shadow1234", "master1234", "michael123", "jennifer123",
  "jessica123", "charlie123", "jordan2323", "michelle123", "danielle123", "elizabeth1",
  "christopher", "christopher1", "alexander1", "alexandra1", "katherine1", "victoria123",
  "butterfly1", "butterfly123", "chocolate1", "chocolate123", "strawberry", "strawberry1",
  "blueberry1", "pineapple1", "watermelon", "watermelon1", "rainbow123", "flower1234",
  "computer123", "internet123", "administrator", "admin12345", "admin123456", "administrator1",
  "trustno1234", "whatever123", "something1", "nothing123", "secret1234", "secretpassword",
  "helloworld", "helloworld1", "helloworld123", "hellohello", "goodmorning", "goodluck123",
  "happyday123", "happiness1", "freedom123", "blessed123", "jesus12345", "godisgood1",
  "jesuschrist", "jesuslovesme", "christmas1", "christmas123", "summer2024", "summer2025",
  "summer2026", "winter2024", "winter2025", "winter2026", "spring2025", "autumn2025",
  "family1234", "myfamily123", "ourfamily1", "household1", "household123", "kinpassword",
  "kinkinkinkin", "letmein1234", "access1234", "1234qwerasdf", "qwer1234asdf", "asdf1234qwer",
  "1qaz2wsx3e", "!qaz2wsx3edc", "qazwsxedcrfv", "qazwsxedc123", "1234abcd5678", "11223344556",
  "aaaaaaaaaa1", "a1b2c3d4e5", "a1b2c3d4e5f6", "1a2b3c4d5e", "zxcvbnmasdf", "mnbvcxzlkj",
  "iloveyou!!", "password!!", "qwerty!@#$", "1234567890!", "!@#$%^&*()", "1qazxsw23edc",
]);
