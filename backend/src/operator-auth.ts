import {getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {HttpsError, type CallableRequest} from 'firebase-functions/v2/https';
if(!getApps().length) initializeApp();
export async function requireOperator(r:CallableRequest){
 if(!r.auth || !(r.auth.token.operator===true || r.auth.token.admin===true)) throw new HttpsError('permission-denied','Operator access required.');
 const profile=(await getFirestore().doc(`operators/${r.auth.uid}`).get()).data();
 if(profile?.enabled!==true) throw new HttpsError('permission-denied','Operator account is disabled or has not been provisioned.');
 return r.auth.uid;
}
