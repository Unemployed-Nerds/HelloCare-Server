const { db } = require('../config/firebase');

/**
 * Firestore helper service for common CRUD operations
 */

/**
 * Get a document from a collection
 */
async function getDocument(collection, docId) {
  try {
    const doc = await db.collection(collection).doc(docId).get();
    if (!doc.exists) {
      return null;
    }
    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error(`Error getting document from ${collection}:`, error);
    throw error;
  }
}

/**
 * Create a document in a collection
 */
async function createDocument(collection, data, docId = null) {
  try {
    const docRef = docId 
      ? db.collection(collection).doc(docId)
      : db.collection(collection).doc();

    await docRef.set({
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return { id: docRef.id, ...data };
  } catch (error) {
    console.error(`Error creating document in ${collection}:`, error);
    throw error;
  }
}

/**
 * Update a document in a collection
 */
async function updateDocument(collection, docId, data) {
  try {
    const docRef = db.collection(collection).doc(docId);
    await docRef.update({
      ...data,
      updatedAt: new Date().toISOString()
    });

    const updatedDoc = await docRef.get();
    return { id: updatedDoc.id, ...updatedDoc.data() };
  } catch (error) {
    console.error(`Error updating document in ${collection}:`, error);
    throw error;
  }
}

/**
 * Delete a document from a collection
 */
async function deleteDocument(collection, docId) {
  try {
    await db.collection(collection).doc(docId).delete();
    return true;
  } catch (error) {
    console.error(`Error deleting document from ${collection}:`, error);
    throw error;
  }
}

/**
 * Query documents from a collection with filters
 */
async function queryDocuments(collection, filters = [], orderBy = null, limit = null) {
  try {
    let query = db.collection(collection);

    // Apply filters
    filters.forEach(filter => {
      query = query.where(filter.field, filter.operator, filter.value);
    });

    // Apply ordering
    if (orderBy) {
      query = query.orderBy(orderBy.field, orderBy.direction || 'desc');
    }

    // Apply limit
    if (limit) {
      query = query.limit(limit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`Error querying documents from ${collection}:`, error);
    throw error;
  }
}

/**
 * Query documents with pagination
 */
async function queryDocumentsPaginated(collection, filters = [], orderBy = null, page = 1, pageSize = 20) {
  try {
    let query = db.collection(collection);

    // Apply filters
    filters.forEach(filter => {
      query = query.where(filter.field, filter.operator, filter.value);
    });

    // Apply ordering
    if (orderBy) {
      query = query.orderBy(orderBy.field, orderBy.direction || 'desc');
    }

    // Get total count (approximate for pagination info)
    const countSnapshot = await query.get();
    const total = countSnapshot.size;

    // Apply pagination
    const offset = (page - 1) * pageSize;
    if (offset > 0) {
      const offsetSnapshot = await query.limit(offset).get();
      if (!offsetSnapshot.empty) {
        const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
        query = query.startAfter(lastDoc);
      }
    }
    query = query.limit(pageSize);

    const snapshot = await query.get();
    const documents = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return {
      documents,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  } catch (error) {
    console.error(`Error querying paginated documents from ${collection}:`, error);
    throw error;
  }
}

module.exports = {
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  queryDocuments,
  queryDocumentsPaginated
};

