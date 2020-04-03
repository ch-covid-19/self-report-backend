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
const DB_GLOBAL_CHANGES = env.db.global_changes;
const DB_INDIVIDUAL_REPORT_V2_SUSPICIOUS = env.db.suspicious;

const EXPORT_SECURITY_TOKEN = env.export.token;

const HTTP_OK = 200;

const RECAPTCHA_SECRET = env.recaptcha.secret;
const RECAPTCHA_VERIFY_URL = env.recaptcha.verifyurl;

const pad0 = n => n < 10 ? `0${n}` : `${n}`;

const getDayStamp = (date) => date.getFullYear() + '-' + pad0(date.getMonth() + 1) + pad0(date.getDate());

const createOrUpdateChange = async (transaction, postalCode, changeRef, oldDiagnostic, newDiagnostic, baseData) => {
  const snapshot = await transaction.get(changeRef);
  const diagnostics = snapshot.exists ? snapshot.data().diagnostics : {};

  // Might be the case if no previous record, so no old diagnostic to erase
  if (oldDiagnostic !== null) {
    if (diagnostics[oldDiagnostic] === undefined) diagnostics[oldDiagnostic] = 0;
    diagnostics[oldDiagnostic] -= 1;
  }

  if (diagnostics[newDiagnostic] === undefined) diagnostics[newDiagnostic] = 0;
  diagnostics[newDiagnostic] += 1;

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
const firestoreAppendChanges = async (db, postalCode, oldDiagnostic, newDiagnostic) => {
  const daystamp = getDayStamp(new Date());
  const globalChangeRef = db.collection(DB_GLOBAL_CHANGES).doc(`${postalCode}`);
  const currentChangeRef = db.collection(DB_DAILY_CHANGES).doc(`${postalCode}-${daystamp}`);
  const baseData = { postalCode };

  await db.runTransaction(async (transaction) => {
    await createOrUpdateChange(transaction, postalCode, globalChangeRef, oldDiagnostic, newDiagnostic, baseData);
    await createOrUpdateChange(transaction, postalCode, currentChangeRef, oldDiagnostic, newDiagnostic, {
      ...baseData,
      daystamp
    });
  });
};

exports.daily_report = functions.region(REGION).https.onRequest(async (req, res) => cors(req, res, async () => {
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
      try {
        // Retrieve latest change if any
        const previousStateSnapshot = await db.collection(DB_INDIVIDUAL_REPORT_V2)
            .where('sessionId', '==', sessionId)
            .orderBy('timestamp', 'desc')
            .get();

        // Check if we have a previous record, and update daily change accordingly
        if (!previousStateSnapshot.empty) {
          const previousState = previousStateSnapshot.docs[0];
          // Different diagnostic, update db
          if (previousState.diagnostic !== diagnostic) {
            await firestoreAppendChanges(db, locator, previousState.diagnostic, diagnostic);
          }
        } else {
          // No previous record, we simply add the diagnostic to current daily change
          await firestoreAppendChanges(db, locator, null, diagnostic);
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

exports.report = functions.region(REGION).https.onRequest(async (req, res) =>
   cors(req, res, async () => {
      console.log('Report request received');

      //Front-end will send the token
      const {token, symptoms, locator, sessionId, diagnostic} = req.body;
      const db = admin.firestore();

      if (token === undefined) return res.status(400).send('token is missing');
      if (locator === undefined) return res.status(400).send('postal code is missing');
      if (sessionId === undefined) return res.status(400).send('session id is missing');
      if (diagnostic === undefined) return res.status(400).send('diagnostic is missing');

      console.log('Report data is valid');

      try {
        console.log('Verifying recaptcha token');
        const response = await axios.post(
            `${RECAPTCHA_VERIFY_URL}?secret=${RECAPTCHA_SECRET}&response=${token}`,
            {},
            {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
              },
            },
        );

        const data = response.data;
        console.log('Token verification finished', data);

        if (!data.success) {
          console.error('recaptcha token is not valid');
          return res.status(400).send('Recaptcha token is not valid');
        }

        console.log('recaptcha token is valid, score:', data.score);
        const suspicious = data.score < 0.7;

        const targetDb = suspicious ? DB_INDIVIDUAL_REPORT_V2_SUSPICIOUS : DB_INDIVIDUAL_REPORT_V2;

        try {
          const report = {
            locator,
            sessionId,
            symptoms,
            diagnostic,
            timestamp: new Date(),
            score: data.score,
          };
          console.log('Adding report to DB: ', targetDb, report);
          await db.collection(targetDb).add(report);

          console.log('Report added');
          res.status(HTTP_OK).send('');

        } catch (error) {
          console.log('Error adding the report to the database', error);
          res.status(500).send(`Could not register your report: ${error}`);
        }

      } catch (error) {
        console.log('error during recaptcha verification', error);
        res.status(500).send(error);
      }
    })
);


exports.export_json = functions.region(REGION).https.onRequest((req, res) => {

  if (req.method !== 'GET') {
    res.status(400).json({"error": "Wrong HTTP Method used"});
  }

  const { start, end, token } = req.query;

  if (end === undefined) return res.status(400).send('end is missing');
  if (start === undefined) return res.status(400).send('start is missing');

  if (token !== EXPORT_SECURITY_TOKEN) {
    res.status(401).json({"error": "Invalid security token"});
  }

  const db = admin.firestore();
  db.collection(DB_INDIVIDUAL_REPORT)
      .where('timestamp', '>=', new Date(start))
      .where('timestamp', '<', new Date(end))
      .get().then(snapshot => {
        if (snapshot.empty) res.status(404).json({"error": "Empty collection"});
        else res.status(200).json(snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
      })
      .catch(err => {
        console.log('Error getting documents', err);
        res.status(400).json({"error": "Error getting documents"})
      });
});
