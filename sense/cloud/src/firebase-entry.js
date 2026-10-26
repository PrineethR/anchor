// The slice of the Firebase web SDK the site uses. build.py bundles this into cloud/lib/firebase.js in the built site.
export { initializeApp } from 'firebase/app';
export {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCredential,
  onAuthStateChanged, signOut, connectAuthEmulator,
} from 'firebase/auth';
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, CACHE_SIZE_UNLIMITED, connectFirestoreEmulator,
  doc, collection, getDoc, getDocs, getDocFromCache, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, runTransaction, Bytes, serverTimestamp, disableNetwork, enableNetwork,
} from 'firebase/firestore';
