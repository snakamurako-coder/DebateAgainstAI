/*** ===================== 環境定数 ===================== ***/
const INBOX_DIR = 'inbox_submissions';
const PROCESSED_DIR = 'processed';
const THEMES_DIR = 'Themes'; // Google スプレッドシートのみ対象

// 検索・自動生成用ファイル名
const LEGACY_WHITELIST_FILE_NAME = 'AI英会話_利用者ホワイトリスト'; // マージ用（新規作成しない）
const THEME_SAMPLE_BOOK_NAME = 'Sample_Book';
const THEME_BOOK_SHEET_NAME = 'Assignments';
const THEME_BOOK_HEADER = [
  '通し番号', '見出し', '生成AIへの指示文', '英会話の状況設定', '生徒への表示文',
  '役割A', 'Aの最初の台詞', '役割B', 'Bの最初の台詞',
  'フィードバックの仕方', 'フィードバック直前の提示情報', '問題文', '備考'
];
const THEME_BOOK_SAMPLE_ROW = [
  1, 'Self Introduction', 'You are a new student.', 'School cafeteria', 'Talk to the new student.',
  'Student A', 'Hi, I am new here.', 'Student B', 'Nice to meet you.',
  'Focus on grammar.', 'Try to use "Nice to meet you".', '', ''
];

// スクリプトプロパティキー
const LEGACY_WHITELIST_SS_PROP_KEY = 'WHITELIST_SPREADSHEET_ID'; // マージ後に削除
const LEGACY_WHITELIST_MIGRATED_KEY = 'LEGACY_WHITELIST_MIGRATED';
const DEFAULT_BOOK_PROP_KEY = 'DEFAULT_THEME_BOOK_ID';

// 初回セットアップ時に登録する作成者（EffectiveUser が取れない場合のフォールバック）
const CREATOR_EMAIL_FALLBACK = 'snakamurako@yamagataps.jp';
const CREATOR_NAME = 'Kojiro Nakamura';
const CREATOR_ID4 = '0000';
const CREATOR_INITIAL_PASSWORD = 'changeme';

// OpenAI（gpt-4o-mini 固定運用）
const OPENAI_API_BASE = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_TEMPERATURE = 0.7;

/*** ====== 利用者管理（認証 + プロフィール統合） ====== ***/
const LOG_SHEET_NAME = '本人確認ログ';
const LOG_HEADER = ['タイムスタンプ', 'メール', '確定氏名', '確定４桁ID', '本人か', '代理４桁ID', '代理氏名', 'UserAgent', 'クライアントTS'];
// レガシー WL マージ用
const LEGACY_WHITELIST_SHEET_NAME = 'アクセス許可者';

const USERS_SS_PROP_KEY = 'USERS_SPREADSHEET_ID';
const USERS_FILE_NAME = 'AI英会話_users';
const USERS_SHEET_NAME = 'users';
const USERS_HEADER = [
  'メールアドレス', '氏名', '４桁ID', '初期パスワード', '登録PIN',
  'ステータス', '連続ミス回数', 'ロック解除時刻'
];
const MAX_FAIL_COUNT = 4;
const LOCK_HOURS = 24;
const COL_EMAIL = 0;
const COL_NAME = 1;
const COL_ID4 = 2;
const COL_INITIAL_PW = 3;
const COL_PIN = 4;
const COL_STATUS = 5;
const COL_FAIL_COUNT = 6;
const COL_LOCK_UNTIL = 7;
const STATUS_UNREGISTERED = '未登録';
const STATUS_REGISTERED = '登録済';

/*** ===================== Web アプリ入口 ===================== ***/
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('英会話（半自動ターン進行）');
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.parameter && e.parameter.d) || '{}');
    const result = dispatchAction_(body);
    return jsonResponse_(result);
  } catch (err) {
    const resp = { status: 'error', message: String(err.message || err) };
    if (err.locked) {
      resp.locked = true;
      resp.lockedUntil = err.lockedUntil || '';
    }
    return jsonResponse_(resp);
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** bootstrap（Drive/SS 参照）が必要な action のみ実行して起動を軽くする */
const BOOTSTRAP_ACTIONS_ = {
  auth_verify_initial: true,
  auth_register_pin: true,
  auth_login: true,
  auth_check_lock: true,
  get_user_profile: true,
  list_books: true,
  list_units: true,
  list_problems: true,
  submit_task: true,
  submit_identity: true
};

function dispatchAction_(body) {
  const action = _s(body && body.action);
  if (!action) throw new Error('action が指定されていません');

  if (BOOTSTRAP_ACTIONS_[action]) {
    bootstrapAppResources_();
  }

  switch (action) {
    case 'auth_verify_initial':
      return wrapSuccess_(authVerifyInitial_(body));
    case 'auth_register_pin':
      return wrapSuccess_(authRegisterPin_(body));
    case 'auth_login':
      return wrapSuccess_(authLogin_(body));
    case 'auth_check_lock':
      return wrapSuccess_(authCheckLock_(body));
    case 'get_user_profile':
      return wrapSuccess_(getUserProfile_(body));
    case 'ensure_users_book':
      return wrapSuccess_(ensureUsersBookReady_());
    case 'list_books':
      return wrapSuccess_({
        books: listThemeBooksCached(!!body.forceUpdate),
        defaultBookId: PropertiesService.getScriptProperties().getProperty(DEFAULT_BOOK_PROP_KEY) || ''
      });
    case 'list_units':
      return wrapSuccess_(listThemeUnitsCached(body.spreadsheetId, !!body.forceUpdate));
    case 'list_problems':
      return wrapSuccess_(listThemeProblemsCached(body.spreadsheetId, body.sheetName, !!body.forceUpdate));
    case 'start_conversation':
      return wrapSuccess_(startConversation(body.messages, body.cefr, body.row, body.userRoleName));
    case 'continue_conversation':
      return wrapSuccess_(continueConversation(body.messages, body.cefr, body.row, body.userRoleName));
    case 'get_feedback':
      return wrapSuccess_(getFeedback(body.messages, body.cefr, body.row, body.userRoleName, body.extraMeta));
    case 'submit_task':
      return wrapSuccess_(submitTask(body.gIdentity, body.bookName, body.unitName, body.row, body.messages, body.returnedFB, body.cefr, body.userRoleName));
    case 'submit_identity':
      return wrapSuccess_(submitIdentityConfirmation(body));
    default:
      throw new Error('不明な action: ' + action);
  }
}

function wrapSuccess_(data) {
  return { status: 'success', data: data };
}

function normalizeEmail_(email) {
  return _s(email).toLowerCase();
}

function validatePin_(pin) {
  return /^\d{8}$/.test(_s(pin));
}

function getOrCreateUsersSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(USERS_SS_PROP_KEY);
  if (savedId) {
    try {
      const ss = SpreadsheetApp.openById(savedId);
      finalizeUsersSpreadsheet_(ss, props);
      return ss;
    } catch (_) {
      props.deleteProperty(USERS_SS_PROP_KEY);
    }
  }

  const parentId = getParentFolderId_();
  const parent = DriveApp.getFolderById(parentId);
  const files = parent.getFilesByName(USERS_FILE_NAME);

  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.openById(files.next().getId());
  } else {
    ss = SpreadsheetApp.create(USERS_FILE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(parent);
    const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
    if (def) ss.deleteSheet(def);
  }

  finalizeUsersSpreadsheet_(ss, props);
  return ss;
}

function finalizeUsersSpreadsheet_(ss, props) {
  _getOrCreateSheet_(ss, USERS_SHEET_NAME, USERS_HEADER);
  const usersSh = ss.getSheetByName(USERS_SHEET_NAME);
  upgradeUsersSheetSchema_(usersSh);
  polishUsersSpreadsheet_(usersSh);
  const logSh = _getOrCreateSheet_(ss, LOG_SHEET_NAME, LOG_HEADER);
  polishIdentityLogSheet_(logSh);
  migrateLegacyWhitelistIfNeeded_(ss);
  setupUsersSheetAdminGuide_(usersSh);
  ensureUsersCreatorSampleRow_(usersSh);
  props.setProperty(USERS_SS_PROP_KEY, ss.getId());
}

function polishUsersSpreadsheet_(sh) {
  if (!sh) return;
  sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
  const header = sh.getRange(1, 1, 1, USERS_HEADER.length);
  header.setFontWeight('bold');
  header.setBackground('#dce6f1');
  header.setHorizontalAlignment('center');
  header.setWrap(true);
  sh.setFrozenRows(1);
  const widths = [240, 120, 72, 140, 100, 88, 110, 160];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function polishIdentityLogSheet_(sh) {
  if (!sh) return;
  sh.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]);
  const header = sh.getRange(1, 1, 1, LOG_HEADER.length);
  header.setFontWeight('bold');
  header.setBackground('#eef2f6');
  sh.setFrozenRows(1);
}

function ensureUsersBookReady_() {
  const ss = getOrCreateUsersSpreadsheet_();
  const usersSh = ss.getSheetByName(USERS_SHEET_NAME);
  const creatorSampleAdded = ensureUsersCreatorSampleRow_(usersSh);
  return {
    ready: true,
    usersSpreadsheetId: ss.getId(),
    creatorEmail: getCreatorEmail_(),
    creatorSampleAdded: creatorSampleAdded
  };
}

/**
 * 旧6列 users シートを8列（氏名・４桁ID 追加）にアップグレード
 */
function upgradeUsersSheetSchema_(sh) {
  if (!sh) return;
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim());

  if (headerRow.indexOf('氏名') >= 0) {
    sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
    return;
  }

  const isOldSchema = headerRow[COL_EMAIL] === 'メールアドレス' &&
    headerRow.indexOf('氏名') < 0 &&
    (headerRow.indexOf('初期パスワード') === 1 || headerRow[1] === '初期パスワード');

  if (isOldSchema) {
    sh.insertColumnsAfter(1, 2);
  }

  sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
}

/**
 * 旧ホワイトリスト SS のプロフィール・本人確認ログを users SS にマージ（1回限り）
 */
function findUserRowInSheet_(sh, email) {
  const normalized = normalizeEmail_(email);
  if (!normalized || !sh) return null;
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    const rowEmail = normalizeEmail_(values[r][COL_EMAIL]);
    if (rowEmail && rowEmail === normalized) {
      return { rowIndex: r + 1, row: values[r] };
    }
  }
  return null;
}

function migrateLegacyWhitelistIfNeeded_(usersSs) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(LEGACY_WHITELIST_MIGRATED_KEY) === '1') return;

  const savedId = props.getProperty(LEGACY_WHITELIST_SS_PROP_KEY);
  let legacySs = null;

  if (savedId) {
    try {
      legacySs = SpreadsheetApp.openById(savedId);
    } catch (_) {}
  }

  if (!legacySs) {
    try {
      const parentId = getParentFolderId_();
      const parent = DriveApp.getFolderById(parentId);
      const files = parent.getFilesByName(LEGACY_WHITELIST_FILE_NAME);
      if (files.hasNext()) {
        legacySs = SpreadsheetApp.openById(files.next().getId());
      }
    } catch (_) {}
  }

  const usersSh = usersSs.getSheetByName(USERS_SHEET_NAME);

  if (legacySs && usersSh) {
    const wlSh = legacySs.getSheetByName(LEGACY_WHITELIST_SHEET_NAME);
    if (wlSh) {
      const values = wlSh.getDataRange().getValues();
      if (values.length >= 2) {
        const header = values[0].map(v => String(v).trim());
        const colAccount = header.indexOf('アカウント');
        const colName = header.indexOf('氏名');
        const colId4 = header.indexOf('４桁ID');
        if (colAccount >= 0) {
          for (let r = 1; r < values.length; r++) {
            const row = values[r];
            const email = normalizeEmail_(row[colAccount]);
            if (!email) continue;
            const wlName = colName >= 0 ? _s(row[colName]) : '';
            const wlId4 = colId4 >= 0 ? _normalizeId4_(row[colId4]) : '';
            const hit = findUserRowInSheet_(usersSh, email);
            if (hit) {
              if (wlName && !_s(hit.row[COL_NAME])) {
                usersSh.getRange(hit.rowIndex, COL_NAME + 1).setValue(wlName);
              }
              if (wlId4 && !_s(hit.row[COL_ID4])) {
                usersSh.getRange(hit.rowIndex, COL_ID4 + 1).setValue(wlId4);
              }
            }
          }
        }
      }
    }

    const legacyLog = legacySs.getSheetByName(LOG_SHEET_NAME);
    const destLog = usersSs.getSheetByName(LOG_SHEET_NAME);
    if (legacyLog && destLog && destLog.getLastRow() <= 1) {
      const logValues = legacyLog.getDataRange().getValues();
      if (logValues.length > 1) {
        const rows = logValues.slice(1);
        if (rows.length) {
          destLog.getRange(2, 1, 1 + rows.length, rows[0].length).setValues(rows);
        }
      }
    }
  }

  props.deleteProperty(LEGACY_WHITELIST_SS_PROP_KEY);
  props.setProperty(LEGACY_WHITELIST_MIGRATED_KEY, '1');
}

function getCreatorEmail_() {
  const fromSession = _s(Session.getEffectiveUser().getEmail());
  if (fromSession) return normalizeEmail_(fromSession);
  return normalizeEmail_(CREATOR_EMAIL_FALLBACK);
}

function ensureUsersCreatorSampleRow_(sh) {
  if (!sh) return false;
  const creatorEmail = getCreatorEmail_();
  const sampleRow = [
    creatorEmail, CREATOR_NAME, CREATOR_ID4, CREATOR_INITIAL_PASSWORD,
    '', STATUS_UNREGISTERED, 0, ''
  ];
  const hit = findUserRowInSheet_(sh, creatorEmail);
  if (hit) {
    if (!_s(hit.row[COL_NAME])) {
      sh.getRange(hit.rowIndex, COL_NAME + 1).setValue(CREATOR_NAME);
    }
    if (!_s(hit.row[COL_ID4])) {
      sh.getRange(hit.rowIndex, COL_ID4 + 1).setValue(CREATOR_ID4);
    }
    if (!_s(hit.row[COL_INITIAL_PW])) {
      sh.getRange(hit.rowIndex, COL_INITIAL_PW + 1).setValue(CREATOR_INITIAL_PASSWORD);
    }
    return false;
  }
  if (sh.getLastRow() <= 1) {
    sh.getRange(2, 1, 2, USERS_HEADER.length).setValues([sampleRow]);
  } else {
    sh.appendRow(sampleRow);
  }
  return true;
}

function ensureDefaultThemeBookId_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty(DEFAULT_BOOK_PROP_KEY);
  if (saved) {
    try {
      DriveApp.getFileById(saved);
      ensureThemeBookStructure_(saved);
      return saved;
    } catch (_) {
      props.deleteProperty(DEFAULT_BOOK_PROP_KEY);
    }
  }

  const folder = getOrCreateThemesFolder_();
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  let bookId = '';
  while (files.hasNext()) {
    const f = files.next();
    if (!bookId) bookId = f.getId();
  }
  if (!bookId) {
    bookId = setupSampleTheme_(folder);
  } else {
    ensureThemeBookStructure_(bookId);
  }
  if (bookId) props.setProperty(DEFAULT_BOOK_PROP_KEY, bookId);
  return bookId || '';
}

function ensureThemeBookStructure_(bookId) {
  if (!bookId) return;
  const ss = SpreadsheetApp.openById(bookId);
  let sh = ss.getSheetByName(THEME_BOOK_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(THEME_BOOK_SHEET_NAME);
  }

  const lastRow = Math.max(1, sh.getLastRow());
  const lastCol = THEME_BOOK_HEADER.length;
  const firstRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const headerMissing = firstRow.every(v => String(v || '').trim() === '') ||
    String(firstRow[0] || '').trim() !== THEME_BOOK_HEADER[0];

  if (headerMissing) {
    sh.getRange(1, 1, 1, lastCol).setValues([THEME_BOOK_HEADER]);
  }

  if (sh.getLastRow() < 2) {
    sh.appendRow(THEME_BOOK_SAMPLE_ROW);
  }

  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function setupUsersSheetAdminGuide_(sh) {
  if (!sh) return;
  sh.getRange(1, COL_EMAIL + 1).setNote('【必須】利用者のメールアドレス（ログインID）');
  sh.getRange(1, COL_NAME + 1).setNote('【推奨】氏名（提出・表示に使用）');
  sh.getRange(1, COL_ID4 + 1).setNote('【推奨】4桁ID（例: 0001）');
  sh.getRange(1, COL_INITIAL_PW + 1).setNote('【必須】初回ログイン用の初期パスワード（教員から配布）');
  sh.getRange(1, COL_PIN + 1).setNote('【自動】初回ログイン後に利用者が登録');
  sh.getRange(1, COL_STATUS + 1).setNote('未登録 → 登録済（自動更新）');
  sh.getRange(1, COL_FAIL_COUNT + 1).setNote(
    '【管理者】ロック解除: 0 に設定してください。'
  );
  sh.getRange(1, COL_LOCK_UNTIL + 1).setNote(
    '【管理者】ロック解除: セルを空欄にしてください。G列（連続ミス回数）も0にすると確実です。'
  );
}

function getUserRowValues_(rowIndex) {
  const sh = getUsersSheet_();
  return sh.getRange(rowIndex, 1, 1, USERS_HEADER.length).getValues()[0];
}

function getUserLockStatus_(email) {
  const hit = findUserRow_(email);
  if (!hit) {
    return { locked: false, failCount: 0, lockedUntil: '', email: normalizeEmail_(email) };
  }
  return getUserLockStatusByRow_(hit.rowIndex);
}

function getUserLockStatusByRow_(rowIndex) {
  const row = getUserRowValues_(rowIndex);
  const failCount = Number(row[COL_FAIL_COUNT] || 0);
  const lockUntilRaw = _s(row[COL_LOCK_UNTIL]);

  // 管理者が F 列を空欄にした場合はロック解除とみなす
  if (!lockUntilRaw) {
    return { locked: false, failCount: failCount, lockedUntil: '', email: normalizeEmail_(row[COL_EMAIL]) };
  }

  const lockUntil = parseLockUntil_(lockUntilRaw);
  if (!lockUntil) {
    return { locked: false, failCount: failCount, lockedUntil: '', email: normalizeEmail_(row[COL_EMAIL]) };
  }

  if (isLocked_(lockUntil)) {
    return {
      locked: true,
      failCount: failCount,
      lockedUntil: lockUntil.toISOString(),
      email: normalizeEmail_(row[COL_EMAIL])
    };
  }

  // 期限切れ: シート上も自動クリア
  const sh = getUsersSheet_();
  clearExpiredLock_(sh, rowIndex, row);
  return { locked: false, failCount: 0, lockedUntil: '', email: normalizeEmail_(row[COL_EMAIL]) };
}

function authCheckLock_(body) {
  const email = normalizeEmail_(body.email);
  if (!email) throw new Error('メールアドレスを入力してください');
  return getUserLockStatus_(email);
}

function getUsersSheet_() {
  const ss = getOrCreateUsersSpreadsheet_();
  const sh = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sh) throw new Error('users シートが見つかりません');
  return sh;
}

function findUserRow_(email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) return null;
  const sh = getUsersSheet_();
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    const rowEmail = normalizeEmail_(values[r][COL_EMAIL]);
    if (rowEmail && rowEmail === normalized) {
      return { rowIndex: r + 1, row: values[r] };
    }
  }
  return null;
}

function parseLockUntil_(cellValue) {
  const raw = _s(cellValue);
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d;
}

function isLocked_(lockUntilDate) {
  if (!lockUntilDate) return false;
  return new Date().getTime() < lockUntilDate.getTime();
}

function formatLockUntilForSheet_(date) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(date, tz, 'yyyy/MM/dd HH:mm:ss');
}

function clearExpiredLock_(sh, rowIndex, row) {
  const lockUntil = parseLockUntil_(row[COL_LOCK_UNTIL]);
  if (lockUntil && !isLocked_(lockUntil)) {
    sh.getRange(rowIndex, COL_LOCK_UNTIL + 1).setValue('');
    if (Number(row[COL_FAIL_COUNT] || 0) >= MAX_FAIL_COUNT) {
      sh.getRange(rowIndex, COL_FAIL_COUNT + 1).setValue(0);
    }
    return null;
  }
  return lockUntil;
}

function checkServerLock_(rowIndex) {
  const status = getUserLockStatusByRow_(rowIndex);
  if (status.locked) {
    return {
      locked: true,
      lockedUntil: status.lockedUntil,
      message: '連続で間違えたため、24時間アクセスできません'
    };
  }
  return null;
}

function recordAuthFailure_(rowIndex, currentFailCount) {
  const sh = getUsersSheet_();
  const next = Number(currentFailCount || 0) + 1;
  sh.getRange(rowIndex, COL_FAIL_COUNT + 1).setValue(next);

  if (next >= MAX_FAIL_COUNT) {
    const lockUntil = new Date(Date.now() + LOCK_HOURS * 60 * 60 * 1000);
    sh.getRange(rowIndex, COL_LOCK_UNTIL + 1).setValue(formatLockUntilForSheet_(lockUntil));
    return {
      locked: true,
      lockedUntil: lockUntil.toISOString(),
      failCount: next,
      message: '連続で間違えたため、24時間アクセスできません'
    };
  }
  return {
    locked: false,
    failCount: next,
    remaining: MAX_FAIL_COUNT - next,
    message: '認証に失敗しました（残り' + (MAX_FAIL_COUNT - next) + '回）'
  };
}

function resetAuthFailures_(rowIndex) {
  const sh = getUsersSheet_();
  sh.getRange(rowIndex, COL_FAIL_COUNT + 1, 1, 2).setValues([[0, '']]);
}

function authVerifyInitial_(body) {
  const email = normalizeEmail_(body.email);
  const initialPassword = _s(body.initialPassword);
  if (!email) throw new Error('メールアドレスを入力してください');
  if (!initialPassword) throw new Error('初期パスワードを入力してください');

  const hit = findUserRow_(email);
  if (!hit) {
    throw new Error('メールアドレスまたは初期パスワードが正しくありません');
  }

  const lock = checkServerLock_(hit.rowIndex);
  if (lock) {
    const err = new Error(lock.message);
    err.locked = true;
    err.lockedUntil = lock.lockedUntil;
    throw err;
  }

  const status = _s(hit.row[COL_STATUS]);
  const storedPw = _s(hit.row[COL_INITIAL_PW]);
  if (status !== STATUS_UNREGISTERED || storedPw !== initialPassword) {
    const fail = recordAuthFailure_(hit.rowIndex, hit.row[COL_FAIL_COUNT]);
    if (fail.locked) {
      const err = new Error(fail.message);
      err.locked = true;
      err.lockedUntil = fail.lockedUntil;
      throw err;
    }
    throw new Error(fail.message);
  }

  return { nextStep: 'register_pin', email: email };
}

function authRegisterPin_(body) {
  const email = normalizeEmail_(body.email);
  const pin = _s(body.pin);
  if (!email) throw new Error('メールアドレスを入力してください');
  if (!validatePin_(pin)) throw new Error('PINは生年月日8桁（数字8桁）で入力してください');

  const hit = findUserRow_(email);
  if (!hit) throw new Error('ユーザーが見つかりません');

  const lock = checkServerLock_(hit.rowIndex);
  if (lock) {
    const err = new Error(lock.message);
    err.locked = true;
    err.lockedUntil = lock.lockedUntil;
    throw err;
  }

  if (_s(hit.row[COL_STATUS]) !== STATUS_UNREGISTERED) {
    throw new Error('このアカウントは既に登録済みです。ログイン画面からPINを入力してください');
  }

  const sh = getUsersSheet_();
  sh.getRange(hit.rowIndex, COL_PIN + 1).setValue(pin);
  sh.getRange(hit.rowIndex, COL_STATUS + 1).setValue(STATUS_REGISTERED);
  resetAuthFailures_(hit.rowIndex);

  return { authenticated: true, email: email };
}

function authLogin_(body) {
  const email = normalizeEmail_(body.email);
  const pin = _s(body.pin);
  if (!email) throw new Error('メールアドレスを入力してください');
  if (!validatePin_(pin)) throw new Error('PINは生年月日8桁（数字8桁）で入力してください');

  const hit = findUserRow_(email);
  if (!hit) {
    throw new Error('メールアドレスまたはPINが正しくありません');
  }

  const lock = checkServerLock_(hit.rowIndex);
  if (lock) {
    const err = new Error(lock.message);
    err.locked = true;
    err.lockedUntil = lock.lockedUntil;
    throw err;
  }

  const status = _s(hit.row[COL_STATUS]);
  const storedPin = _s(hit.row[COL_PIN]);
  if (status !== STATUS_REGISTERED || storedPin !== pin) {
    const fail = recordAuthFailure_(hit.rowIndex, hit.row[COL_FAIL_COUNT]);
    if (fail.locked) {
      const err = new Error(fail.message);
      err.locked = true;
      err.lockedUntil = fail.lockedUntil;
      throw err;
    }
    throw new Error(fail.message);
  }

  resetAuthFailures_(hit.rowIndex);
  return { authenticated: true, email: email };
}

function getUserProfile_(body) {
  const email = normalizeEmail_(body.email);
  if (!email) return { email: '', found: false, name: '', id4: '' };
  const hit = _lookupUserProfileByEmail_(email);
  return {
    email: email,
    found: !!hit,
    name: hit ? hit.name : '',
    id4: hit ? hit.id4 : ''
  };
}

/*** ===================== ユーティリティ ===================== ***/
const _s = v => (v == null ? '' : String(v).trim());
const stripControl_ = s => (s ? s.replace(/[\u0000-\u001F\u007F]/g, '') : '');
function sanitizeFileName_(s) {
  return (s || '').replace(/[\\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function _eqCaseInsensitive_(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function _normalizeId4_(v) {
  const n = String(v == null ? '' : v).trim().replace(/\D/g, '');
  return n ? ('0000' + n).slice(-4) : '';
}
function _getOrCreateSheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (header && header.length) sh.appendRow(header);
  } else if (header && header.length) {
    const firstRow = sh.getRange(1, 1, 1, Math.max(1, header.length)).getValues()[0];
    const isEmptyHeader = firstRow.every(v => String(v || '').trim() === '');
    if (isEmptyHeader) {
      sh.getRange(1, 1, 1, header.length).setValues([header]);
    }
  }
  return sh;
}

/*** ===================== フォルダ関連 ===================== ***/
/*** ===================== フォルダ・ファイル自動生成 ===================== ***/
function getParentFolderId_() {
  const file = DriveApp.getFileById(ScriptApp.getScriptId());
  const it = file.getParents();
  if (!it.hasNext()) throw new Error('親フォルダが見つかりません');
  return it.next().getId();
}
function getOrCreateSubfolder_(parentFolderId, name) {
  const parent = DriveApp.getFolderById(parentFolderId);
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function ensureInbox_() {
  const parentId = getParentFolderId_();
  getOrCreateSubfolder_(parentId, PROCESSED_DIR);
  return getOrCreateSubfolder_(parentId, INBOX_DIR).getId();
}

/**
 * Themesフォルダを取得、無ければ作成。
 * フォルダ内にSSが一つも無ければサンプルブックを作成。
 */
function getOrCreateThemesFolder_() {
  const parentId = getParentFolderId_();
  const parent = DriveApp.getFolderById(parentId);

  let folder;
  const it = parent.getFoldersByName(THEMES_DIR);
  if (it.hasNext()) {
    folder = it.next();
  } else {
    folder = parent.createFolder(THEMES_DIR);
  }

  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  if (!files.hasNext()) {
    setupSampleTheme_(folder);
  }
  return folder;
}

function setupSampleTheme_(folder) {
  const ss = SpreadsheetApp.create(THEME_SAMPLE_BOOK_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  const bookId = ss.getId();
  ensureThemeBookStructure_(bookId);
  PropertiesService.getScriptProperties().setProperty(DEFAULT_BOOK_PROP_KEY, bookId);
  return bookId;
}

/**
 * 初回セットアップ：users・テーマブックを作成し、見出し・管理者登録・ID 保存まで行う
 */
function bootstrapAppResources_() {
  const props = PropertiesService.getScriptProperties();
  const needsBootstrap = !props.getProperty(USERS_SS_PROP_KEY) ||
    !props.getProperty(DEFAULT_BOOK_PROP_KEY);

  const users = getOrCreateUsersSpreadsheet_();
  const bookId = ensureDefaultThemeBookId_();
  const inboxId = ensureInbox_();

  return {
    bootstrapped: needsBootstrap,
    usersSpreadsheetId: users.getId(),
    defaultBookId: bookId,
    inboxFolderId: inboxId,
    creatorEmail: getCreatorEmail_(),
    scriptProperties: {
      USERS_SPREADSHEET_ID: props.getProperty(USERS_SS_PROP_KEY) || '',
      DEFAULT_THEME_BOOK_ID: props.getProperty(DEFAULT_BOOK_PROP_KEY) || ''
    }
  };
}

/**
 * デバッグ用：手動で初期化フローを実行してログを確認するための関数
 */
function debugSetup() {
  console.log('Starting debugSetup...');
  try {
    const result = bootstrapAppResources_();
    console.log('Bootstrap result:', JSON.stringify(result));
    return 'Setup completed successfully.\n' + JSON.stringify(result, null, 2);
  } catch (e) {
    console.error('Setup failed:', e);
    return 'Error: ' + e.message;
  }
}

/*** ===================== テーマ一覧取得（共通キャッシュ） ===================== ***/
// ブック一覧（Themes フォルダ直下の Google スプレッドシートのみ）
// ブック一覧（Themes フォルダ直下の Google スプレッドシートのみ）
function listThemeBooksCached(forceUpdate) {
  const cache = CacheService.getScriptCache();
  const key = 'themeBooks';
  if (!forceUpdate) {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }
  const themes = getOrCreateThemesFolder_(); // ★変更
  const files = themes.getFiles();
  const out = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
      out.push({ id: f.getId(), name: f.getName() });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  cache.put(key, JSON.stringify(out), 3600);
  return out;
}

// ユニット一覧（Assignments があれば固定、なければ全シート（非隠し））
function listThemeUnitsCached(spreadsheetId, forceUpdate) {
  const cache = CacheService.getScriptCache();
  const key = 'themeUnits:' + spreadsheetId;
  if (!forceUpdate) {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const assignments = ss.getSheetByName('Assignments');
  const units = assignments
    ? ['Assignments']
    : ss.getSheets()
      .filter(sh => !sh.isSheetHidden())
      .map(sh => sh.getName());
  cache.put(key, JSON.stringify(units), 3600);
  return units;
}

// 問題一覧（Assignments 優先／行抽出は緩和）
function listThemeProblemsCached(spreadsheetId, sheetName, forceUpdate) {
  const cache = CacheService.getScriptCache();
  const key = `themeProblems:${spreadsheetId}:${sheetName}`;
  if (!forceUpdate) {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }
  const rows = listThemeProblems(spreadsheetId, sheetName);
  cache.put(key, JSON.stringify(rows), 3600);
  return rows;
}

function listThemeProblems(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sh = ss.getSheetByName('Assignments') || ss.getSheetByName(sheetName);
  if (!sh) throw new Error(`シートが見つかりません: ${sheetName}`);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const h = values[0].map(_s);
  const idx = {
    serial: h.indexOf('通し番号'), title: h.indexOf('見出し'),
    sys: h.indexOf('生成AIへの指示文'), ctx: h.indexOf('英会話の状況設定'),
    disp: h.indexOf('生徒への表示文'),
    roleA: h.indexOf('役割A'), roleAFirst: h.indexOf('Aの最初の台詞'),
    roleB: h.indexOf('役割B'), roleBFirst: h.indexOf('Bの最初の台詞'),
    fb: h.indexOf('フィードバックの仕方'),
    prefb: h.indexOf('フィードバック直前の提示情報'),
    prompt: h.indexOf('問題文'), note: h.indexOf('備考')
  };

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const hasTitle = idx.title >= 0 && _s(row[idx.title]);
    const hasSerial = idx.serial >= 0 && _s(row[idx.serial]);
    if (!hasTitle && !hasSerial) continue;

    rows.push({
      rowIndex: r + 1,
      serial: _s(idx.serial >= 0 ? row[idx.serial] : ''),
      title: _s(idx.title >= 0 ? row[idx.title] : ''),
      sys: _s(idx.sys >= 0 ? row[idx.sys] : ''),
      context: _s(idx.ctx >= 0 ? row[idx.ctx] : ''),
      displayText: _s(idx.disp >= 0 ? row[idx.disp] : ''),
      roleA: _s(idx.roleA >= 0 ? row[idx.roleA] : ''),
      roleAFirst: _s(idx.roleAFirst >= 0 ? row[idx.roleAFirst] : ''),
      roleB: _s(idx.roleB >= 0 ? row[idx.roleB] : ''),
      roleBFirst: _s(idx.roleBFirst >= 0 ? row[idx.roleBFirst] : ''),
      feedbackStyle: _s(idx.fb >= 0 ? row[idx.fb] : ''),
      preFeedbackTip: _s(idx.prefb >= 0 ? row[idx.prefb] : ''),
      prompt: _s(idx.prompt >= 0 ? row[idx.prompt] : ''),
      note: _s(idx.note >= 0 ? row[idx.note] : '')
    });
  }
  return rows;
}

/*** ===================== OpenAI 呼び出し ===================== ***/
function sanitizeMessages_(messages, keepPairs) {
  const systems = [], ua = [];
  if (!Array.isArray(messages)) messages = [];
  for (const m of messages) {
    const role = m && m.role;
    const content = stripControl_(_s(m && m.content));
    if (!content) continue;
    if (role === 'system') systems.push({ role, content });
    else if (role === 'user' || role === 'assistant') ua.push({ role, content });
  }
  const keptUA = []; let pairs = 0;
  for (let i = ua.length - 1; i >= 0; i--) {
    keptUA.unshift(ua[i]);
    if (ua[i].role === 'user') { if (++pairs >= keepPairs) break; }
  }
  return systems.concat(keptUA);
}

function chat_(messages, opts) {
  const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY 未設定（スクリプトプロパティに設定してください）');

  const model = OPENAI_MODEL;
  const keepPairs = (opts && opts.keepPairs) || 4;
  const maxTokens = (opts && opts.maxTokens) || 320;

  const sanitized = sanitizeMessages_(messages, keepPairs);
  const body = { model, messages: sanitized, max_tokens: maxTokens };
  if (typeof OPENAI_TEMPERATURE === 'number') body.temperature = OPENAI_TEMPERATURE;

  const res = UrlFetchApp.fetch(OPENAI_API_BASE, {
    method: 'post',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`OpenAI error ${code}: ${text}`);

  const json = JSON.parse(text || '{}');
  const msg = ((json.choices || [])[0] || {}).message || {};
  return stripControl_(_s(msg.content));
}

/*** ===================== 役割ロック補助 ===================== ***/
/**
 * 仕様：役割B もしくは Bの最初のセリフが参照できない場合は
 *       「AI=A固定／ユーザー=B固定」とする。
 * 返値：
 *  { lockToA, userRoleName, aiRoleName, studentRoleName, aiFirstLine }
 */
function getEffectiveRolePack_(row, requestedUserRoleName) {
  const roleA = _s(row && row.roleA) || 'A';
  const roleB = _s(row && row.roleB) || 'B';
  const aFirst = _s(row && row.roleAFirst) || '';
  const bFirst = _s(row && row.roleBFirst) || '';

  const lockToA = (!row || !_s(row.roleB) || !_s(row.roleBFirst)); // 参照不可＝空扱い

  if (lockToA) {
    return {
      lockToA: true,
      userRoleName: roleB,         // ユーザー=B固定
      aiRoleName: roleA,           // AI=A固定
      studentRoleName: roleB,      // 学習者はB
      aiFirstLine: aFirst          // AI(=A)の最初の台詞
    };
  }

  // 通常: フロントの選択を尊重（既定A/B）
  const req = _s(requestedUserRoleName) || roleA;
  const userIsA = (req === roleA);
  return {
    lockToA: false,
    userRoleName: req,
    aiRoleName: userIsA ? roleB : roleA,
    studentRoleName: userIsA ? roleA : roleB,
    aiFirstLine: userIsA ? bFirst : aFirst
  };
}

/*** ===================== systemプロンプト生成 ===================== ***/
function buildSystemPrompt_({ cefr, userRoleName, row }) {
  const pack = getEffectiveRolePack_(row, userRoleName);

  const lines = [];
  lines.push(`You are an English conversation partner for CEFR ${cefr || 'A2'} learners.`);
  lines.push(`Roles: Learner = ${pack.studentRoleName}; Assistant = ${pack.aiRoleName}.`);
  if (row && row.context) lines.push(`Context: ${row.context}`);
  if (row && row.sys) lines.push(`Instructions: ${row.sys}`);
  lines.push(`Strict Rules:
 - Always stay strictly in your assigned role: you are the ${pack.aiRoleName}. The learner is the ${pack.studentRoleName}.
 - Never speak lines that belong to the ${pack.studentRoleName} role (do not play both sides).
 - Keep turns short and simple (CEFR ${cefr || 'A2'}).
 - Ask one question at a time ONLY if it is natural for the ${pack.aiRoleName} in this situation.
 - If the learner is confused, rephrase more simply.
 - Only when it appears for the first time in the conversation, pretend not to understand what a non-assimilated loanword means and ask the speaker to explain it.
 - Do not add extra sentences that switch roles or move the scene ahead on your own.`);

  if (pack.aiFirstLine) {
    lines.push(`Begin immediately. On your first turn ONLY, reply with EXACTLY the following line and nothing else: "${pack.aiFirstLine}"`);
  }
  return lines.join('\n');
}

/*** ===================== （内部）セッション実装 ===================== ***/
function startSession(payload) {
  const sys = buildSystemPrompt_(payload);
  const messages = [{ role: 'system', content: sys }];
  const first = chat_(messages, { maxTokens: 320, keepPairs: 4 });
  if (first) messages.push({ role: 'assistant', content: first });
  const pack = getEffectiveRolePack_(payload.row, payload.userRoleName);
  return {
    messages,
    learnerFirstLine: (pack.userRoleName === (_s(payload.row.roleA) || 'A') ? _s(payload.row.roleAFirst) : _s(payload.row.roleBFirst)) || ''
  };
}

/*** ===================== フィードバック生成 ===================== ***/
function formatTranscript_(messages, userRoleName, row) {
  const uName = _s(userRoleName) || 'Learner';
  const roleA = _s(row && row.roleA);
  const roleB = _s(row && row.roleB);
  let aiName = 'Assistant';
  if (roleA && roleB) {
    if (_s(userRoleName) === roleA) aiName = roleB;
    else if (_s(userRoleName) === roleB) aiName = roleA;
  }
  const stripLeading = s => String(s || '').replace(/^(?:AI|User)(?:\([^)]*\))?:\s*/i, '');
  const lines = [];
  if (!Array.isArray(messages)) messages = [];
  for (const m of messages) {
    const content = stripControl_(_s(m && m.content));
    if (!content) continue;
    if (m.role === 'user') lines.push(`User(${uName}): ${stripLeading(content)}`);
    else if (m.role === 'assistant') lines.push(`AI(${aiName}): ${stripLeading(content)}`);
  }
  return lines.join('\n');
}

function requestFeedback(payload, messages) {
  if (!payload || !payload.row) throw new Error('payload/row missing');

  const pack = getEffectiveRolePack_(payload.row, payload.userRoleName);

  let transcript = _s(payload.transcriptLabeled);
  if (!transcript) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('no messages');
    transcript = formatTranscript_(messages, pack.userRoleName, payload.row);
  }

  const fbStyle = payload.row.feedbackStyle ? `\nPreferences: ${payload.row.feedbackStyle}` : '';
  const sys = `You are an English teacher.
You will receive a full dialogue transcript with lines labeled "User(${pack.userRoleName}): ..." and "AI(${pack.aiRoleName}): ...".
Give concise, constructive feedback for a CEFR ${payload.cefr || 'A2'} learner.${fbStyle}

STRICT RULES:
- Evaluate and comment ONLY on lines that start with "User(${pack.userRoleName}):".
- DO NOT evaluate, praise, or criticize any "AI(${pack.aiRoleName}):" lines (context only).
- Use Japanese.
- Keep it short and actionable (2–5 bullets).
- If you show examples, rewrite them briefly and more naturally.
- Start your reply with "フィードバック：".`;

  const req = [
    { role: 'system', content: sys },
    { role: 'user', content: transcript }
  ];
  const feedback = chat_(req, { maxTokens: 320, keepPairs: 4 }) || '';
  return { feedback };
}

/*** ===================== 提出保存（JSON） ===================== ***/
function getInboxStatus() {
  const files = DriveApp.getFolderById(ensureInbox_()).getFiles();
  let c = 0; while (files.hasNext()) { files.next(); if (++c >= 10000) break; }
  return { pending: c };
}

function endAndSubmitConversation(payload) {
  const inbox = DriveApp.getFolderById(ensureInbox_());

  // タイムゾーン・時刻
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const tsHuman = Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm:ss');
  const ymdHMS = Utilities.formatDate(now, tz, 'yyMMddHHmmss');

  const bookName = _s(payload.spreadsheetName);
  const unitName = _s(payload.unitName);
  const serial = _s(payload.row && payload.row.serial);
  const title = _s(payload.row && payload.row.title);
  const cefr = _s(payload.cefr);
  const id4 = _s(payload.studentId4);
  const student = _s(payload.studentName);
  const userRole = _s(payload.userRoleName);

  // ラベル付き会話ログ優先
  const messagesArr = Array.isArray(payload.messages) ? payload.messages : [];
  const interactionRaw = _s(payload.interaction);
  let interaction = interactionRaw;
  if (!/^(?:AI|User)\([^)]+\):\s/m.test(interactionRaw)) {
    if (messagesArr.length) {
      interaction = formatTranscript_(messagesArr, userRole || (payload.row && _s(payload.row.roleA)) || 'A', payload.row || {});
    }
  }
  const returnedFB = _s(payload.returnedFB);

  const rawName = `${bookName}_${serial}_${title}_${cefr || 'A2'}_${id4 || '0000'}_${userRole || 'A'}_${ymdHMS}.json`;
  const safeName = sanitizeFileName_(rawName);

  const out = {
    timestamp: tsHuman,
    book: bookName,
    unit: unitName,
    serial: serial,
    title: title,
    userRole: userRole,
    studentId4: id4,
    studentName: student,
    cefr: cefr,
    interaction: interaction,
    returnedFB: returnedFB
  };

  const blob = Utilities.newBlob(JSON.stringify(out, null, 2), 'application/json', safeName);
  inbox.createFile(blob);
  return { ok: true, fileName: safeName, inboxStatus: getInboxStatus() };
}

/*** ===================== 本人確認（users シート統合） ===================== ***/
function _getActiveUserEmail_() {
  const mail = Session.getActiveUser().getEmail();
  return mail ? mail.trim() : '';
}

function _lookupUserProfileByEmail_(email) {
  const hit = findUserRow_(email);
  if (!hit) return null;
  const name = _s(hit.row[COL_NAME]);
  const id4 = _normalizeId4_(hit.row[COL_ID4]);
  if (!name && !id4) return null;
  return { name: name, id4: id4 };
}

// index.html → init: getAccessProfile()
function getAccessProfile() {
  ensureInbox_();
  const email = normalizeEmail_(_getActiveUserEmail_());
  const hit = _lookupUserProfileByEmail_(email);
  return {
    email: email || '',
    found: !!hit,
    name: hit ? hit.name : '',
    id4: hit ? hit.id4 : '',
    reasonIfNotFound: hit ? '' : 'users シートに氏名・４桁IDが未設定'
  };
}

// index.html → submitIdentityConfirmation(payload)
function submitIdentityConfirmation(payload) {
  const ss = getOrCreateUsersSpreadsheet_();
  const sheet = _getOrCreateSheet_(ss, LOG_SHEET_NAME, LOG_HEADER);
  sheet.appendRow([
    new Date(),
    String(payload.email || ''),
    String(payload.resolvedName || ''),
    String(payload.resolvedId4 || ''),
    String(payload.selfCheck || ''),    // 'はい' | 'いいえ' | ''
    String(payload.proxyId || ''),
    String(payload.proxyName || ''),
    String(payload.userAgent || ''),
    String(payload.ts || '')
  ]);
  return { ok: true };
}

/*** ===================== フロント互換ラッパー（index と関数名を合わせる） ===================== ***/
/**
 * 会話開始：index の startConversation(messages, cefr, row, userRoleName)
 * 返り値は「AIの最初のセリフ（文字列）」だけを返す
 */
function startConversation(messagesIgnored, cefr, row, userRoleName) {
  const payload = { cefr, row, userRoleName };
  const started = startSession(payload);
  const first = (started && started.messages && started.messages[1] && started.messages[1].content) || '';
  return first || '';
}

/**
 * 継続：index の continueConversation(messages, cefr, row, userRoleName)
 * フロントの messages は {role:'user'|'assistant', content:'...'} のみ想定
 * 返り値は「AIの返答（文字列）」
 */
function continueConversation(messages, cefr, row, userRoleName) {
  const sys = buildSystemPrompt_({ cefr, row, userRoleName });
  const serverMsgs = [{ role: 'system', content: sys }];

  if (!Array.isArray(messages)) messages = [];
  for (const m of messages) {
    const role = m && m.role;
    const content = stripControl_(_s(m && m.content));
    if (!content) continue;
    if (role === 'user' || role === 'assistant') serverMsgs.push({ role, content });
  }

  const rep = chat_(serverMsgs, { maxTokens: 320, keepPairs: 4 }) || '';
  return rep;
}

// 記録用定数
const RECORD_FOLDER_NAME = 'AI英会話の記録';
const RECORD_BOOK_NAME = 'InteractionAndFeedback';
const RECORD_SHEET_NAME = 'Log';

/**
 * 記録用フォルダ取得（無ければ作成）
 */
function getOrCreateRecordFolder_() {
  const parentId = getParentFolderId_();
  // マイドライブ直下指定だが、要件は「マイドライブ直下の...」とあるが、
  // 既存のコードは親フォルダ（このスクリプトがある場所）を基準にしていることが多い。
  // "GoogleDrive内のマイドライブ直下の..." と明確に指示があるため、Rootから探すのが正解だが、
  // 既存アプリの構成（すべてプロジェクトフォルダ内）に合わせるか迷うところ。
  // しかし指示は "マイドライブ直下" なので DriveApp.getRootFolder() を使う。
  const root = DriveApp.getRootFolder();
  const it = root.getFoldersByName(RECORD_FOLDER_NAME);
  return it.hasNext() ? it.next() : root.createFolder(RECORD_FOLDER_NAME);
}

/**
 * 記録用シート取得（無ければ作成）
 */
function getOrCreateFeedbackSheet_() {
  const folder = getOrCreateRecordFolder_();
  const files = folder.getFilesByName(RECORD_BOOK_NAME);
  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(RECORD_BOOK_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  }
  // ヘッダー定義
  const header = [
    'Timestamp', 'Book', 'Unit', 'Serial', 'Title',
    'UserRole', 'StudentId', 'StudentName', 'CEFR',
    'Interaction', 'Feedback'
  ];
  // シート取得（なければ作成）
  return _getOrCreateSheet_(ss, RECORD_SHEET_NAME, header);
}

/**
 * ログ記録実行
 */
function logInteractionToSheet_(data) {
  try {
    const sheet = getOrCreateFeedbackSheet_();
    sheet.appendRow([
      new Date(), // Timestamp
      _s(data.bookName),
      _s(data.unitName),
      _s(data.row && data.row.serial),
      _s(data.row && data.row.title),
      _s(data.userRoleName),
      _s(data.studentId4),
      _s(data.studentName),
      _s(data.cefr),
      _s(data.interaction),
      _s(data.feedback)
    ]);
  } catch (e) {
    console.error('Failed to log interaction:', e);
    // ログ記録失敗でユーザーのフィードバック自体を止めるべきではないのでエラーは握りつぶす（ログには残す）
  }
}

/**
 * フィードバック：index の getFeedback(messages, cefr, row, userRoleName, extraMeta)
 * 返り値は「フィードバック本文（文字列）」
 */
function getFeedback(messages, cefr, row, userRoleName, extraMeta) {
  const payload = { cefr, row, userRoleName, transcriptLabeled: '' };

  // 1. フィードバック生成
  const res = requestFeedback(payload, messages);
  const feedbackContent = (res && res.feedback) || '';

  // 2. 記録データの準備 (extraMeta + 生成結果)
  if (extraMeta) {
    const pack = getEffectiveRolePack_(row, userRoleName);
    const transcript = formatTranscript_(messages, pack.userRoleName, row);

    const logData = {
      bookName: extraMeta.bookName,
      unitName: extraMeta.unitName,
      row: row,
      userRoleName: userRoleName,
      studentId4: extraMeta.studentId4,
      studentName: extraMeta.studentName,
      cefr: cefr,
      interaction: transcript,
      feedback: feedbackContent
    };

    // 3. シートへ記録
    logInteractionToSheet_(logData);
  }

  return feedbackContent;
}

/**
 * 提出：index の submitTask(gIdentity, bookName, unitName, row, messages, returnedFB, cefr.value, userRoleSel.value)
 * 返り値は { fileName: '...' }
 */
function submitTask(gIdentity, bookName, unitName, row, messages, returnedFB, cefrOpt, userRoleNameOpt) {
  const payload = {
    spreadsheetName: _s(bookName),
    unitName: _s(unitName),
    row: row || {},
    userRoleName: _s(userRoleNameOpt || ''),
    cefr: _s(cefrOpt || ''),
    studentId4: _s(gIdentity && gIdentity.id4),
    studentName: _s(gIdentity && gIdentity.name),
    interaction: '',
    returnedFB: _s(returnedFB),
    messages: Array.isArray(messages) ? messages : []
  };
  const res = endAndSubmitConversation(payload);
  return { fileName: res && res.fileName ? res.fileName : '' };
}
