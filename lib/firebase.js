import {initializeApp,getApps,getApp} from 'firebase/app';
import {getAuth,initializeAuth,browserSessionPersistence,connectAuthEmulator} from 'firebase/auth';
import {getFirestore,connectFirestoreEmulator} from 'firebase/firestore';
import {getFunctions,connectFunctionsEmulator,httpsCallable} from 'firebase/functions';
let services;
export function firebase(){
 if(services)return services;
 const config={apiKey:process.env.NEXT_PUBLIC_FIREBASE_API_KEY,authDomain:process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,projectId:process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,appId:process.env.NEXT_PUBLIC_FIREBASE_APP_ID};
 if(!config.apiKey||!config.authDomain||!config.projectId||!config.appId)throw Error('Firebase configuration is missing. Copy .env.example to .env.local, fill in the values, and restart the app.');
 const app=getApps().length?getApp():initializeApp(config);let auth;try{auth=initializeAuth(app,{persistence:browserSessionPersistence});}catch(e){if(e.code!=='auth/already-initialized')throw e;auth=getAuth(app);}const db=getFirestore(app),functions=getFunctions(app,process.env.NEXT_PUBLIC_FUNCTIONS_REGION||'europe-west1');
 if(process.env.NEXT_PUBLIC_USE_EMULATORS==='true'){
  if(!config.projectId.startsWith('demo-'))throw Error('Emulators require a demo- project ID to prevent accidental live writes.');
  connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(db,'127.0.0.1',8080);connectFunctionsEmulator(functions,'127.0.0.1',5001);
 }
 services={auth,db,functions};return services;
}
export async function callOperator(name,data={}){return(await httpsCallable(firebase().functions,name,{timeout:30000})(data)).data;}
export function friendlyError(error){const code=error?.code||'';if(['auth/invalid-credential','auth/wrong-password','auth/user-not-found','auth/invalid-email'].includes(code))return 'The email or password is incorrect.';if(code==='auth/too-many-requests')return 'Too many attempts. Wait a few minutes and try again.';if(code==='auth/operation-not-allowed')return 'Email/password sign-in is not enabled in Firebase Authentication.';if(code.includes('permission-denied'))return 'Operator access is unavailable. Ask your administrator to check your account.';if(code==='functions/not-found'||code==='functions/internal')return 'The operation could not finish. Check that the updated backend is deployed, then refresh before retrying.';return error?.message||'Unable to connect. Please try again.';}
