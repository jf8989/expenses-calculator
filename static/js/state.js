// static/js/state.js
import { log, warn, error } from './logger.js'; // Assuming logger utility

const DB_NAME = 'ExpenseSplitDB';
const STORE_NAME = 'userDataStore';
const DATA_KEY = 'currentUserData'; // Key for the single object storing user state
const DB_VERSION = 1; // Increment this if schema changes

let db = null; // Hold the DB connection reference

// --- In-Memory State ---
// Holds the data currently being used/displayed by the application
let appState = {
    isInitialized: false,
    isAuthenticated: false,
    userId: null,
    // participants: [], // <<< REMOVE THIS (Old global "all" participants list)
    frequentParticipants: [], // This is the "starred" list, effectively the new global default for new sessions
    sessions: [],
    activeSessionData: {
        name: '',
        transactions: [],
        participants: [], // Participants specific to this active session
        currencies: { main: 'PEN', secondary: 'USD' }
    },
    lastSyncedTimestamp: null
};

// --- IndexedDB Initialization ---

/**
 * Opens/Creates the IndexedDB database and object store.
 * Should be called once on application startup.
 * @returns {Promise<IDBPDatabase>} A promise that resolves with the DB connection or rejects on error.
 */
export function initDB() {
    return new Promise((resolve, reject) => {
        log('State:initDB', `Initializing IndexedDB: ${DB_NAME} v${DB_VERSION}`);
        if (db) {
            log('State:initDB', 'DB already initialized.');
            resolve(db);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            error('State:initDB', 'IndexedDB error:', event.target.error);
            reject(`IndexedDB error: ${event.target.error}`);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            log('State:initDB', 'IndexedDB initialized successfully.');
            resolve(db);
        };

        // This event only executes if the version number changes
        // or the database is created for the first time.
        request.onupgradeneeded = (event) => {
            log('State:initDB', 'Upgrade needed or DB creation.');
            const tempDb = event.target.result;
            if (!tempDb.objectStoreNames.contains(STORE_NAME)) {
                log('State:initDB', `Creating object store: ${STORE_NAME}`);
                tempDb.createObjectStore(STORE_NAME); // Simple store using explicit key ('currentUserData')
            }
            // Handle future schema upgrades here based on oldVersion
            // const oldVersion = event.oldVersion;
            // if (oldVersion < 2) { /* upgrade logic for v2 */ }
        };
    });
}

// --- IndexedDB State Operations ---

/**
 * Loads the user's state from IndexedDB into the in-memory appState.
 * @returns {Promise<object>} A promise that resolves with the loaded state object.
 */
export async function loadStateFromDB() {
    log('State:loadStateFromDB', 'Attempting to load state from IndexedDB...');

    return new Promise((resolve, reject) => {
        if (!db) {
            error('State:loadStateFromDB', 'DB not initialized. Cannot load state.');
            return reject('DB not initialized');
        }
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(DATA_KEY);

        request.onerror = (event) => {
            error('State:loadStateFromDB', 'Error reading from IndexedDB:', event.target.error);
            reject(`Error reading state: ${event.target.error}`);
        };

        request.onsuccess = (event) => {
            const loadedData = event.target.result;
            const currentAuthStatus = appState.isAuthenticated;
            const currentUserId = appState.userId;

            if (loadedData) {
                log('State:loadStateFromDB', 'State loaded successfully from DB (raw):', JSON.parse(JSON.stringify(loadedData))); // Log a copy

                // Start with defaults, then selectively apply loaded data
                // This prevents old/unexpected fields in loadedData from polluting appState
                const newAppState = {
                    ...getDefaultState(), // Ensures no 'participants' field from default
                    isInitialized: appState.isInitialized, // Preserve previous init flag if any
                    isAuthenticated: currentAuthStatus,
                    userId: currentUserId,

                    // Selectively apply relevant fields from loadedData
                    frequentParticipants: loadedData.frequentParticipants || [],
                    sessions: loadedData.sessions || [],
                    activeSessionData: loadedData.activeSessionData || getDefaultState().activeSessionData,
                    lastSyncedTimestamp: loadedData.lastSyncedTimestamp || null
                };
                appState = newAppState;

                // Log if the old 'participants' field (global list) was found in IndexedDB data
                if (loadedData.hasOwnProperty('participants')) {
                    warn('State:loadStateFromDB', "Detected old 'participants' field in IndexedDB data. This field has been ignored and will not be saved going forward.");
                }
                log('State:loadStateFromDB', 'Processed and applied state from DB:', JSON.parse(JSON.stringify(appState)));
                resolve(appState);
            } else {
                log('State:loadStateFromDB', 'No state found in DB for key:', DATA_KEY);
                appState = {
                    ...getDefaultState(),
                    isAuthenticated: currentAuthStatus,
                    userId: currentUserId
                };
                resolve(appState);
            }
        };
    });
}

/**
 * Saves the current in-memory appState (relevant parts) to IndexedDB.
 * @returns {Promise<void>} A promise that resolves on success or rejects on error.
 */
async function saveStateToDB() {
    if (!db) {
        error('State:saveStateToDB', 'DB not initialized. Cannot save state.');
        return Promise.reject('DB not initialized');
    }
    if (!appState.isAuthenticated || !appState.userId) {
        log('State:saveStateToDB', 'User not authenticated, skipping save.');
        return Promise.resolve();
    }

    const stateToSave = {
        userId: appState.userId,
        // participants: appState.participants, // <<< REMOVE (Old global "all" participants list)
        frequentParticipants: appState.frequentParticipants, // Save the "starred" list
        sessions: appState.sessions, // Saved sessions from Firestore
        activeSessionData: appState.activeSessionData, // Current working session (includes its own participants)
        lastSyncedTimestamp: appState.lastSyncedTimestamp
    };

    log('State:saveStateToDB', 'Saving state to IndexedDB:', stateToSave);

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(stateToSave, DATA_KEY);

        request.onerror = (event) => {
            error('State:saveStateToDB', 'Error writing to IndexedDB:', event.target.error);
            reject(`Error saving state: ${event.target.error}`);
        };

        request.onsuccess = () => {
            log('State:saveStateToDB', 'State saved successfully to IndexedDB.');
            resolve();
        };
    });
}

/**
 * Clears user data from IndexedDB (e.g., on logout).
 * @returns {Promise<void>} A promise that resolves on success or rejects on error.
 */
export function clearDBState() {
    log('State:clearDBState', 'Clearing user data from IndexedDB...');
    if (!db) {
        warn('State:clearDBState', 'DB not initialized.');
        return Promise.resolve(); // Nothing to clear
    }

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(DATA_KEY); // Delete the user's data object

        request.onerror = (event) => {
            error('State:clearDBState', 'Error deleting from IndexedDB:', event.target.error);
            reject(`Error clearing state: ${event.target.error}`);
        };

        request.onsuccess = () => {
            log('State:clearDBState', 'User data cleared successfully from IndexedDB.');
            // Also reset in-memory state
            appState = getDefaultState();
            resolve();
        };
    });
}

// --- In-Memory State Management ---

/**
 * Returns a default structure for the application state.
 */
function getDefaultState() {
    return {
        isInitialized: false,
        isAuthenticated: false,
        userId: null,
        // participants: [], // <<< REMOVE
        frequentParticipants: [], // Default "starred" list is empty
        sessions: [],
        activeSessionData: {
            name: '',
            transactions: [],
            participants: [], // Participants for a new/active session
            currencies: { main: 'PEN', secondary: 'USD' }
        },
        lastSyncedTimestamp: null
    };
}

/**
 * Resets the in-memory state to defaults. Does not clear DB.
 */
export function resetInMemoryState() {
    log('State:resetInMemoryState', 'Resetting in-memory state.');
    appState = getDefaultState();
}

/**
 * Updates the application state with new data, typically after fetching from backend.
 * @param {object} data - Object containing { participants, sessions, timestamp }
 */
export async function updateStateFromServer(data) {
    log('State:updateStateFromServer', 'Updating state from server data:', data);
    // appState.participants = data.participants || []; // <<< REMOVE (No longer using this global "all" list from server)
    appState.frequentParticipants = data.frequentParticipants || []; // Correctly update "starred"
    appState.sessions = data.sessions || []; // Correctly update saved sessions
    appState.lastSyncedTimestamp = data.timestamp || null;
    appState.isInitialized = true;

    // When syncing, reset activeSessionData.
    // Its participants should default to frequentParticipants for a "new session" context.
    appState.activeSessionData = getDefaultState().activeSessionData;
    // For a "new" active session context after sync, use frequentParticipants
    appState.activeSessionData.participants = [...appState.frequentParticipants];
    // TODO: User's preferred currencies for activeSessionData could be loaded here if stored globally.

    await saveStateToDB();
}

// --- Getters ---
export function getSessions() { return [...appState.sessions]; }
export function getSessionById(sessionId) { return appState.sessions.find(s => s.id === sessionId); }
export function getLastSyncedTimestamp() { return appState.lastSyncedTimestamp; }
export function getActiveSessionData() { return { ...appState.activeSessionData, transactions: [...appState.activeSessionData.transactions], participants: [...appState.activeSessionData.participants] }; } // Deeper copy for participants
export function getActiveTransactions() { return [...appState.activeSessionData.transactions]; }
export function getActiveCurrencies() { return { ...appState.activeSessionData.currencies }; }
export function isInitialized() { return appState.isInitialized; }
export function isAuthenticated() { return appState.isAuthenticated; }
export function getUserId() { return appState.userId; }
export function getActiveParticipants() { return [...appState.activeSessionData.participants]; } // This now correctly returns participants of the *active session*
export function getFrequentParticipants() { return [...appState.frequentParticipants]; } // "Starred" list

export function isParticipantFrequent(name) {
    return appState.frequentParticipants.includes(name);
}

export async function toggleFrequentParticipant(name) {
    const list = appState.frequentParticipants;
    const idx = list.indexOf(name);
    if (idx === -1) {
        list.push(name);
    } else {
        list.splice(idx, 1);
    }
    list.sort();
    await saveStateToDB();
    // This change should also be synced to Firestore
    // The handler in handlers.js already calls api.updateFrequentParticipantsApi
    return isParticipantFrequent(name);
}

// --- Setters / Updaters (Modify in-memory state AND trigger save to DB) ---

export async function setAuthState(isAuthenticated, userId) {
    log('State:setAuthState', `Setting auth state: ${isAuthenticated}, User ID: ${userId}`);
    const oldAuthStatus = appState.isAuthenticated;
    appState.isAuthenticated = isAuthenticated;
    appState.userId = userId;

    if (!isAuthenticated) {
        await clearDBState(); // This resets appState to default (active participants empty)
    } else if (!oldAuthStatus && isAuthenticated) { // Transitioning from logged out to logged in
        try {
            await loadStateFromDB(); // Load existing state which might include activeSessionData
            // If loadStateFromDB results in activeSessionData.participants being empty (e.g. new user, cleared state),
            // it will be populated by frequentParticipants later in main.js via updateStateFromServer or
            // if a specific session is loaded.
            log('State:setAuthState', 'User logged in, state loaded from DB. Active session participants:', appState.activeSessionData.participants);

        } catch (err) {
            error('State:setAuthState', 'Error loading state from DB during auth change:', err);
            // Reset to default if load fails, then save this minimal state.
            // getDefaultState() will give empty activeSessionData.participants.
            appState = { ...getDefaultState(), isAuthenticated: true, userId: userId };
            await saveStateToDB();
        }
    }
    // No immediate saveStateToDB() here is fine as other actions will trigger it.
}

export async function setSessions(sessionsList) {
    log('State:setSessions', 'Setting sessions:', sessionsList);
    appState.sessions = sessionsList || [];
    await saveStateToDB();
}

export async function setLastSyncedTimestamp(timestamp) {
    log('State:setLastSyncedTimestamp', 'Setting timestamp:', timestamp);
    appState.lastSyncedTimestamp = timestamp;
    await saveStateToDB(); // Persist timestamp change
}

/**
 * Sets the active session data, usually after loading a saved session.
 * @param {object} session - The full session object (including transactions, participants, etc.)
 */
export async function loadSessionIntoActiveState(session) {
    log('State:loadSessionIntoActiveState', 'Loading session into active state:', session ? session.id : 'new session');
    if (!session) { // For a NEW session
        appState.activeSessionData = getDefaultState().activeSessionData;
        // For a new session, participants default to the "starred" (frequent) list
        appState.activeSessionData.participants = [...appState.frequentParticipants];
        log('State:loadSessionIntoActiveState', 'New session started, participants set from frequent list:', appState.activeSessionData.participants);
    } else { // For an EXISTING session
        appState.activeSessionData = {
            name: session.name || '',
            // Ensure transactions, participants, currencies are deep copied if they are arrays/objects
            transactions: session.transactions ? JSON.parse(JSON.stringify(session.transactions)) : [],
            participants: session.participants ? [...session.participants] : [], // Use session's own list
            currencies: session.currencies ? { ...session.currencies } : getDefaultState().activeSessionData.currencies
        };
        log('State:loadSessionIntoActiveState', `Existing session '${session.name}' loaded, participants:`, appState.activeSessionData.participants);
    }
    await saveStateToDB();
}

// --- Active Transaction Modifiers ---

export async function addActiveTransaction(transaction) {
    log('State:addActiveTransaction', 'Adding active transaction:', transaction);
    // Assign a temporary ID for client-side use if needed? Or rely on index?
    // Let's assume transactions don't need a persistent ID until saved in a session.
    appState.activeSessionData.transactions.push(transaction);
    // Sort transactions? Maybe by date?
    // appState.activeSessionData.transactions.sort((a, b) => /* date comparison */);
    await saveStateToDB();
}
export async function addMultipleActiveTransactions(transactions) {
    log('State:addMultipleActiveTransactions', `Adding ${transactions.length} active transactions.`);
    appState.activeSessionData.transactions.push(...transactions);
    await saveStateToDB();
}


export async function updateActiveTransaction(index, updatedTxData) {
    log('State:updateActiveTransaction', `Updating active transaction at index ${index}:`, updatedTxData);
    if (index >= 0 && index < appState.activeSessionData.transactions.length) {
        // Merge updates carefully
        appState.activeSessionData.transactions[index] = {
            ...appState.activeSessionData.transactions[index], // Keep existing fields
            ...updatedTxData // Overwrite with new data
        };
        await saveStateToDB();
    } else {
        warn('State:updateActiveTransaction', `Invalid index ${index}`);
    }
}
export async function updateActiveTransactionAssignment(index, assigned_to) {
    log('State:updateActiveTransactionAssignment', `Updating assignment at index ${index}:`, assigned_to);
    if (index >= 0 && index < appState.activeSessionData.transactions.length) {
        appState.activeSessionData.transactions[index].assigned_to = assigned_to;
        await saveStateToDB();
    } else {
        warn('State:updateActiveTransactionAssignment', `Invalid index ${index}`);
    }
}
export async function updateActiveTransactionAmount(index, amount) {
    log('State:updateActiveTransactionAmount', `Updating amount at index ${index}:`, amount);
    if (index >= 0 && index < appState.activeSessionData.transactions.length) {
        appState.activeSessionData.transactions[index].amount = amount;
        await saveStateToDB();
    } else {
        warn('State:updateActiveTransactionAmount', `Invalid index ${index}`);
    }
}
export async function updateActiveTransactionCurrency(index, currency) {
    log('State:updateActiveTransactionCurrency', `Updating currency at index ${index}:`, currency);
    if (index >= 0 && index < appState.activeSessionData.transactions.length) {
        appState.activeSessionData.transactions[index].currency = currency;
        await saveStateToDB();
    } else {
        warn('State:updateActiveTransactionCurrency', `Invalid index ${index}`);
    }
}


export async function deleteActiveTransaction(index) {
    log('State:deleteActiveTransaction', `Deleting active transaction at index ${index}`);
    if (index >= 0 && index < appState.activeSessionData.transactions.length) {
        appState.activeSessionData.transactions.splice(index, 1);
        await saveStateToDB();
    } else {
        warn('State:deleteActiveTransaction', `Invalid index ${index}`);
    }
}

export async function deleteAllActiveTransactions() {
    log('State:deleteAllActiveTransactions', 'Deleting all active transactions.');
    appState.activeSessionData.transactions = [];
    await saveStateToDB();
}

export async function unassignAllActiveTransactions() {
    log('State:unassignAllActiveTransactions', 'Unassigning all active transactions.');
    appState.activeSessionData.transactions.forEach(tx => tx.assigned_to = []);
    await saveStateToDB();
}

export async function setActiveCurrencies(mainCurrency, secondaryCurrency) {
    log('State:setActiveCurrencies', `Setting active currencies: Main=${mainCurrency}, Secondary=${secondaryCurrency}`);
    appState.activeSessionData.currencies = { main: mainCurrency, secondary: secondaryCurrency };
    // Do we need to save this immediately? Yes, persist preference.
    await saveStateToDB();
}

export function setInitialized(value) {
    log('State:setInitialized', `Setting initialized status to: ${value}`);
    appState.isInitialized = !!value; // Ensure boolean value
    // No need to save state to DB just for this flag, it's transient session info
}

export async function addParticipantToActiveSession(name) {
    log('State:addParticipantToActiveSession', 'Adding participant to active session:', name);
    const list = appState.activeSessionData.participants;
    if (!list.includes(name)) {
        list.push(name);
        list.sort();
        await saveStateToDB();
        return true;
    }
    return false;
}

export async function deleteParticipantFromActiveSession(name) {
    log('State:deleteParticipantFromActiveSession', 'Deleting participant from active session:', name);
    const before = appState.activeSessionData.participants.length;
    appState.activeSessionData.participants =
        appState.activeSessionData.participants.filter(p => p !== name);
    if (appState.activeSessionData.participants.length !== before) {
        await saveStateToDB();
        return true;
    }
    return false;
}
