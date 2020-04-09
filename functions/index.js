const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors')({
  origin: true,
});

admin.initializeApp(functions.config().firebase);
const env = functions.config();

const DOMAIN = env.host.domain;
const REGION = env.host.region;

const DB_INDIVIDUAL_REPORT_DEV = env.db.dev;
const DB_INDIVIDUAL_REPORT = env.db.report;
const DB_INDIVIDUAL_REPORT_V2 = env.db.report;
const DB_DAILY_CHANGES = env.db.daily_changes;
const DB_INDIVIDUAL_REPORT_V2_SUSPICIOUS = env.db.suspicious;

const EXPORT_SECURITY_TOKEN = env.export.token;

const HTTP_OK = 200;

const RECAPTCHA_SECRET = env.recaptcha.secret;
const RECAPTCHA_VERIFY_URL = env.recaptcha.verifyurl;

const pad0 = n => n < 10 ? `0${n}` : `${n}`;

const getDayStamp = (date) => date.getFullYear() + '-' + pad0(date.getMonth() + 1) + '-' +  pad0(date.getDate());
const getDailyDocKey = (locator, date) => `${locator}--${getDayStamp(date)}`;

const createOrUpdateChange = async (transaction, changeRef, snapshot, oldState, newState, baseData) => {
  const diagnostics = snapshot.exists ? snapshot.data().diagnostics : {};

  if (oldState !== null) {
    const oldDiagnostic = oldState.diagnostic;
    if (diagnostics[oldDiagnostic] === undefined) diagnostics[oldDiagnostic] = 0;
    diagnostics[oldDiagnostic] -= 1;
  }

  if (newState !== null) {
    const newDiagnostic = newState.diagnostic;
    if (diagnostics[newDiagnostic] === undefined) diagnostics[newDiagnostic] = 0;
    diagnostics[newDiagnostic] += 1;
  }

  if (snapshot.exists) await transaction.update(changeRef, { diagnostics });
  else await transaction.set(changeRef, {
    ...baseData,
    diagnostics
  });
};

/**
 * Creates a daily change if doesn't exist or update it to reflect current diagnostic status
 * Also updates global change for NPA
 */
const firestoreAppendChanges = async (db, oldState, newState) => {

  const now = new Date();
  const baseData = { locator: newState.locator, daystamp: getDayStamp(now) };

  const previousDocKey = oldState ? getDailyDocKey(oldState.locator, now) : null;
  const currentDocKey = getDailyDocKey(newState.locator, now);

  // If we updated our diagnostic or npa, reflect it in today's daily changes
  const previousDailyChangeRef = oldState === null ? null : db.collection(DB_DAILY_CHANGES).doc(previousDocKey);
  const currentDailyChangeRef = db.collection(DB_DAILY_CHANGES).doc(currentDocKey);

  await db.runTransaction(async (transaction) => {

    const currentDailySnapshot = await transaction.get(currentDailyChangeRef);

    // If we have to deal with another postal code, first update previous then update newest
    // Only if npa changed, otherwise we can only do 1 doc update/write
    if (previousDailyChangeRef && previousDocKey !== currentDocKey) {
      console.log("Different NPA when reporting status");
      const previousDailySnapshot = await transaction.get(previousDailyChangeRef);
      await createOrUpdateChange(transaction, previousDailyChangeRef, previousDailySnapshot, oldState, null, baseData);
      await createOrUpdateChange(transaction, currentDailyChangeRef, currentDailySnapshot, null, newState, baseData);
    } else {
      // Only update current daily change because either same NPA or no previous daily change
      await createOrUpdateChange(transaction, currentDailyChangeRef, currentDailySnapshot, oldState, newState, baseData);
    }
  });
};

exports.report = functions.region(REGION).https.onRequest(async (req, res) => cors(req, res, async () => {
  console.log('Report request received');

  //Front-end will send the token
  const {token, symptoms, locator, sessionId, diagnostic} = req.body;
  const db = admin.firestore();

  if (token === undefined) return res.status(400).send('token is missing');
  if (locator === undefined) return res.status(400).send('postal code is missing');
  if (sessionId === undefined) return res.status(400).send('session id is missing');
  if (isNaN(diagnostic)) return res.status(400).send('diagnostic is missing');
  console.log('Report data is valid');

  try {
    console.log('Verifying recaptcha token');
    const { data: { success, score }} = await axios.post(`${RECAPTCHA_VERIFY_URL}?secret=${RECAPTCHA_SECRET}&response=${token}`, {}, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
      },
    });

    if (!success) {
      console.error('recaptcha token is not valid');
      return res.status(400).send('Recaptcha token is not valid');
    }

    console.log('recaptcha token is valid, score:', score);
    const suspicious = score < 0.7;
    const targetDb = suspicious ? DB_INDIVIDUAL_REPORT_V2_SUSPICIOUS : DB_INDIVIDUAL_REPORT_V2;

    // Update daily changes if legitimate report
    if (!suspicious) {
      console.log('not suspicious');
      try {
        // Retrieve latest change if any
        const previousStateSnapshot = await db.collection(targetDb)
            .where('sessionId', '==', sessionId)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        // Check if we have a previous record, and update daily change accordingly
        if (!previousStateSnapshot.empty) {
          const previousState = previousStateSnapshot.docs[0].data();

          // Different diagnostic or npa, update db
          if (previousState.diagnostic !== diagnostic || previousState.locator !== locator) {
            await firestoreAppendChanges(db, previousState, { locator, diagnostic });
          }
        } else {
          // No previous record, we simply add the diagnostic to current daily change
          await firestoreAppendChanges(db, null, { locator, diagnostic });
        }
      } catch (e) {
        console.log(e);
        return res.status(500).end();
      }
    }

    // Insert report in db
    const report = {
      locator,
      sessionId,
      symptoms,
      diagnostic,
      timestamp: new Date(),
      score,
    };

    console.log('Adding report to DB: ', targetDb, report);
    await db.collection(targetDb).add(report);
    res.status(HTTP_OK).send('');

  } catch (e) {
    console.log(e);
    res.json(500).end();
  }
}));

const authenticate = (req, res) => {
  let ok = true;

  if (!['GET', 'POST'].includes(req.method)) {
    res.status(400).json({"error": "Wrong HTTP Method used"});
    ok = false;
  }

  if (req.query.token !== EXPORT_SECURITY_TOKEN) {
    res.status(401).json({"error": "Invalid security token"});
    ok = false;
  }

  return ok;
};

exports.build_daily_changes = functions.region(REGION).https.onRequest(async (req, res) => cors(req, res, async () => {
  if (!authenticate(req, res)) return;
  const db = admin.firestore();

  const { collections } = req.query;
  if (collections === undefined) return res.status(400).json({ message: "Missing collections argument" });

  console.log('Starting job with collections: ', collections.split(','));

  // We have to build all reports every time even when date change to make sure we take care of previous reports
  const reports = [];
  await collections.split(',').reduce((acc, colName) => acc.then(() => new Promise((resolve) => {
    db.collection(colName).orderBy('timestamp', 'asc').get().then((snapshot) => {
      snapshot.docs.forEach((item) => {
        reports.push(item.data());
      });
      resolve();
    });
  })), Promise.resolve());

  // build daily changes
  const dailyChanges = new Map();

  // Keeps each user previous report to change if necessary
  const userPreviousState = new Map();
  reports.forEach(({ locator, sessionId, diagnostic, timestamp }) => {
    if (locator === undefined || sessionId === undefined || diagnostic === undefined || timestamp === undefined) return;
    const dateTimestamp = new Date(timestamp.toDate());
    const key = getDailyDocKey(locator, dateTimestamp);
    const dailyChange = dailyChanges.has(key) ? dailyChanges.get(key) : {
      daystamp: getDayStamp(dateTimestamp),
      diagnostics: {},
      locator,
    };

    if (userPreviousState.has(sessionId)) {
      let downGradedDailyChange = dailyChange;
      const previousState = userPreviousState.get(sessionId);
      const downGradedKey = getDailyDocKey(previousState.locator, dateTimestamp);

      // User previously reported on different postal code
      if (locator !== previousState.locator) {
        downGradedDailyChange = dailyChanges.has(downGradedKey) ? dailyChanges.get(downGradedKey) : {
          locator: previousState.locator,
          daystamp: getDayStamp(dateTimestamp),
          diagnostics: {}
        };
      }

      // Downgrade previous state diagnostic
      if (downGradedDailyChange.diagnostics[previousState.diagnostic] === undefined) downGradedDailyChange.diagnostics[previousState.diagnostic] = 0;
      downGradedDailyChange.diagnostics[previousState.diagnostic] -= 1;

      // Update down graded daily change
      dailyChanges.set(downGradedKey, downGradedDailyChange);
    }

    // Increment daily change diagnostic
    if (dailyChange.diagnostics[diagnostic] === undefined) dailyChange.diagnostics[diagnostic] = 0;
    dailyChange.diagnostics[diagnostic] += 1;

    // Update daily changes
    dailyChanges.set(key, dailyChange);

    // add diagnostic mapped to user session
    userPreviousState.set(sessionId, { diagnostic, locator });
  });

  // Write all daily changes to firestore per batch of size 500 every second to avoid reaching limit
  const dailyChangesArray = Array.from(dailyChanges);
  const batchs = Math.ceil(dailyChangesArray.length / 500);

  await [...Array(batchs).keys()].reduce((acc, batchId) => acc.then(() => new Promise((resolve) => {
    const itemsToTreat = dailyChangesArray.slice(batchId * 500, (batchId + 1)*500);
    const batch = db.batch();
    itemsToTreat.forEach(([docKey, docContent]) => {
      const ref = db.collection(DB_DAILY_CHANGES).doc(docKey);
      batch.set(ref, docContent);
    });
    batch.commit().then(() => {
      resolve();
    }).catch((err) => {
      res.status(500).json({
        message: err.message,
        reports: reports.length,
        batchs,
      });
      process.exit(10);
    });
  })), Promise.resolve());


  res.status(200).json({ message: "Done generating daily changes :)", reports: reports.length, batchs });
}));

exports.daily_json = functions.region(REGION).https.onRequest( async (req, res) => cors(req, res, async () => {

  if (!authenticate(req, res)) return;

  const { date } = req.query;
  const daystamp = date ? date : getDayStamp(new Date());
  const db = admin.firestore();

  console.log('retrieving daily changes for ' + daystamp);
  db.collection(DB_DAILY_CHANGES)
      .where('daystamp', '==', daystamp)
      .get().then(snapshot => res.status(200).json(snapshot.docs.map(doc => doc.data())))
      .catch(err => {
        console.log('Error getting documents', err);
        res.status(400).json({"error": "Error getting documents"})
      });
}));
