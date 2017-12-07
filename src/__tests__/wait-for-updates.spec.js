import { mongoUrl, tailUrl, tailDatabaseName } from './config'
import findRootKeys, { Domain } from '../find-root-keys'
import { update as _update } from '../update'

/**
 * Idea: we should be able to wait via a Promise until all expected updates
 * (to root instances of the domain) are finished.
 */

import { MongoClient } from 'mongodb'
import { Cache } from '../index';

const initResolverWhenDoneWaiting = state => {
  if (state.resolver) {
    state.resolver()
  }
  state.resolvedWhenDoneWaiting = new Promise(res => state.resolver = res)
}

const enqueue = state => {
  if (state.numWaiting++ === 0) {
    initResolverWhenDoneWaiting(state)
  }
  console.log('enqueue, numWaiting', state.numWaiting)
}

const dequeue = state => {
  state.numWaiting -= 1
  console.log('dequeue, numWaiting', state.numWaiting)
  if (state.numWaiting === 0) {
    initResolverWhenDoneWaiting(state)
  }
}

const wrapCollectionObj = (original, collName, state) => {
  const wrapper = {}
  for (let prop in original) {
    if (typeof (original[prop]) === 'function') {
      const fnName = prop
      wrapper[fnName] = function () {
        // console.log('calling collection Fn', fnName)
        const result = original[fnName].apply(this, arguments)
        switch (fnName) {
          case 'insertOne':
            enqueue(state)
            result.then(async res => {
              console.log(`insertOne done, insertedId:`, res.insertedId)
              await findRootKeys(
                state.domain,
                state.db,
                collName,
                arguments[0],
                state.rootKeysToUpdate
              )
              dequeue(state)
            }).catch(err => {
              dequeue(state)
              throw err
            })
            break
          default:
          // do nothing
        }
        return result
      }
    } else {
      wrapper[prop] = original[prop]
    }
  }
  return wrapper
}

const wrapCollectionFn = (db, state) => function () {
  const coll = db.collection.apply(this, arguments)
  const collectionName = arguments[0]
  // console.log('getting collection', collectionName)
  if (!state.collectionWrappers[collectionName]) {
    state.collectionWrappers[collectionName] = wrapCollectionObj(coll, collectionName, state)
  }
  return state.collectionWrappers[collectionName]
}

const domainMongo = async ({ domain, mongoUrl, tailUrl, tailDatabaseName }) => {
  const wrappedDb = await MongoClient.connect(mongoUrl)

  // TODO: Cache should have resolved promise of connect() as constructor arg?
  const cache = new Cache(MongoClient.connect(mongoUrl))

  const state = {
    collectionWrappers: {}, // maps collection name to collection wrapper
    domain,
    numWaiting: 0,
    rootKeysToUpdate: new Set(),
    db: wrappedDb
  }
  initResolverWhenDoneWaiting(state)

  // we must wrap the Collection class 
  // ... and then record all root ids that we need to run an update on, for
  // each function that changes a type we know in the domain

  const wrapper = {}
  for (let prop in wrappedDb) {
    if (typeof (wrappedDb[prop]) === 'function') {
      switch (prop) {
        case 'collection':
          wrapper.collection = wrapCollectionFn(wrappedDb, state)
          break
        default:
          wrapper[prop] = wrappedDb[prop]
      }
    } else {
      wrapper[prop] = wrappedDb[prop]
    }
  }

  const update = key => _update(cache, domain, key)

  wrapper.updateDomainNow = async () => {
    const promise = state.resolvedWhenDoneWaiting
    if (state.numWaiting === 0) {
      initResolverWhenDoneWaiting(state)
    }
    const rootKeys = Array.from(state.rootKeysToUpdate)
    console.log('updateDomainNow, rootKeys', rootKeys)
    state.rootKeysToUpdate = new Set()
    return promise.then(
      async () => Promise.all(
        Array.from(rootKeys).map(async key => {
          console.log('About to update (from rootKeys)', key)
          return update(key)
        })
      )
    )
  }

  return wrapper
}

const hasCollection = async (name, db) => {
  return (await db.collections())
    .filter(c => c.collectionName === name) > 0
}

const domain: Domain = {
  root: 'things',
  types: {
    things: {
      hasMany: {
        parts: {
          of: 'parts',
          foreignKey: 'thingId'
        }
      },
      hasOne: {},
      derivedProps: {
        totalWeight: {
          f: self => self.parts.get().map(part => part.weight).reduce((sum, v) => sum + v, 0)
        }
      }
    },
    parts: {
    }
  }
}

describe('Waiting for updates', () => {
  it('works', async () => {
    const db = await domainMongo({
      domain,
      mongoUrl,
      tailUrl,
      tailDatabaseName
    })
    const things = db.collection('things')
    const parts = db.collection('parts')
    // TODO: just to request the same collection again (triggers
    // cache of Collection instance wrappers)
    const partsAgain = db.collection('parts')
    const thing = { name: `New thing at ${new Date}` }
    await things.insertOne(thing)

    // just double check we call still use the 'collections' function
    // (which should *not* be wrapped)
    expect(
      hasCollection('things', db)
    ).toBeTruthy()

    // console.log('thing', thing)
    const part = {
      name: `This is a part of thing ${thing._id}`,
      thingId: thing._id,
      weight: Math.floor(Math.random() * 1000)
    }
    await parts.insertOne(part)
    // console.log('part', part)

    // TODO: we want a bit more here: If we do not
    // say "make sure all domain updates are done", then
    // a debounce'd update should kick in.
    // if we *do* say we want them done, then we should trigger them
    // immediately and wait until they are finished.
    await db.updateDomainNow()
    const thingAgain = await things.findOne({ _id: thing._id })

    // now we expect derived properties in '_D' in 'thingAgain' to be updated
    expect(thingAgain._D.totalWeight).toBe(part.weight)
  })
})