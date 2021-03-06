import path from 'path';
import { cloneDeep, trim } from 'lodash';
import csvStringify from 'csv-stringify';
import { clipboard } from 'electron'; // eslint-disable-line import/no-unresolved
import { getCurrentDBConn, getDBConnByName } from './connections';
import { rowsValuesToString } from '../utils/convert';
import { showSaveDialog, saveFile } from '../utils/file-handler';
import wait from '../utils/wait';


export const NEW_QUERY = 'NEW_QUERY';
export const RENAME_QUERY = 'RENAME_QUERY';
export const SELECT_QUERY = 'SELECT_QUERY';
export const REMOVE_QUERY = 'REMOVE_QUERY';
export const EXECUTE_QUERY_REQUEST = 'EXECUTE_QUERY_REQUEST';
export const EXECUTE_QUERY_SUCCESS = 'EXECUTE_QUERY_SUCCESS';
export const EXECUTE_QUERY_FAILURE = 'EXECUTE_QUERY_FAILURE';
export const CANCEL_QUERY_REQUEST = 'CANCEL_QUERY_REQUEST';
export const CANCEL_QUERY_SUCCESS = 'CANCEL_QUERY_SUCCESS';
export const CANCEL_QUERY_FAILURE = 'CANCEL_QUERY_FAILURE';
export const COPY_QUERY_RESULT_TO_CLIPBOARD_REQUEST = 'COPY_QUERY_RESULT_TO_CLIPBOARD_REQUEST';
export const COPY_QUERY_RESULT_TO_CLIPBOARD_SUCCESS = 'COPY_QUERY_RESULT_TO_CLIPBOARD_SUCCESS';
export const COPY_QUERY_RESULT_TO_CLIPBOARD_FAILURE = 'COPY_QUERY_RESULT_TO_CLIPBOARD_FAILURE';
export const SAVE_QUERY_REQUEST = 'SAVE_QUERY_REQUEST';
export const SAVE_QUERY_SUCCESS = 'SAVE_QUERY_SUCCESS';
export const SAVE_QUERY_FAILURE = 'SAVE_QUERY_FAILURE';
export const UPDATE_QUERY = 'UPDATE_QUERY';


export function newQuery (database) {
  return { type: NEW_QUERY, database };
}


export function renameQuery (name) {
  return { type: RENAME_QUERY, name };
}


export function selectQuery (id) {
  return { type: SELECT_QUERY, id };
}


export function removeQuery (id) {
  return { type: REMOVE_QUERY, id };
}


export function executeQueryIfNeeded (query, queryId) {
  return (dispatch, getState) => {
    if (shouldExecuteQuery(query, getState())) {
      dispatch(executeQuery(query, false, null, queryId));
    }
  };
}


export function executeDefaultSelectQueryIfNeeded (database, table) {
  return async (dispatch, getState) => {
    const currentState = getState();
    const dbConn = getDBConnByName(database);
    const queryDefaultSelect = await dbConn.getQuerySelectTop(table);

    if (!shouldExecuteQuery(queryDefaultSelect, currentState)) {
      return;
    }

    if (needNewQuery(currentState, database, queryDefaultSelect)) {
      dispatch({ type: NEW_QUERY, database, table });
    }

    dispatch({ type: UPDATE_QUERY, query: queryDefaultSelect, table });
    dispatch(executeQuery(queryDefaultSelect, true, dbConn));
  };
}

export function updateQueryIfNeeded (query, selectedQuery) {
  return (dispatch, getState) => {
    if (shouldUpdateQuery(query, selectedQuery, getState())) {
      dispatch(updateQuery(query, selectedQuery));
    }
  };
}

function updateQuery (query, selectedQuery) {
  return { type: UPDATE_QUERY, query, selectedQuery };
}

function shouldUpdateQuery (query, selectedQuery, state) {
  const currentQuery = getCurrentQuery(state);
  if (!currentQuery) return true;
  if (currentQuery.isExecuting) return false;
  if (query === currentQuery.query
      && (selectedQuery !== undefined && selectedQuery === currentQuery.selectedQuery)) {
    return false;
  }

  return true;
}

export function appendQuery (query) {
  return (dispatch, getState) => {
    const currentQuery = getCurrentQuery(getState()).query;
    const newLine = !currentQuery ? '' : '\n';
    const appendedQuery = `${currentQuery}${newLine}${query}`;
    if (!currentQuery.isExecuting) {
      dispatch(updateQuery(appendedQuery));
    }
  };
}


export function copyToClipboard (rows, type) {
  return async dispatch => {
    dispatch({ type: COPY_QUERY_RESULT_TO_CLIPBOARD_REQUEST });
    try {
      let value;
      if (type === 'CSV') {
        value = await stringifyResultToCSV(rows);
      } else {
        // force the next dispatch be separately
        // handled of the previous one
        await wait(0);
        value = JSON.stringify(rows, null, 2);
      }
      clipboard.writeText(value);
      dispatch({ type: COPY_QUERY_RESULT_TO_CLIPBOARD_SUCCESS });
    } catch (error) {
      dispatch({ type: COPY_QUERY_RESULT_TO_CLIPBOARD_FAILURE, error });
    }
  };
}


export function saveQuery () {
  return async (dispatch, getState) => {
    dispatch({ type: SAVE_QUERY_REQUEST });
    try {
      const currentQuery = getCurrentQuery(getState());
      const filters = [
        { name: 'SQL', extensions: ['sql'] },
        { name: 'All Files', extensions: ['*'] },
      ];

      let filename = (currentQuery.filename || await showSaveDialog(filters));
      if (path.extname(filename) !== '.sql') {
        filename += '.sql';
      }

      await saveFile(filename, currentQuery.query);
      const name = path.basename(filename, '.sql');

      dispatch({ type: SAVE_QUERY_SUCCESS, name, filename });
    } catch (error) {
      dispatch({ type: SAVE_QUERY_FAILURE, error });
    }
  };
}


function shouldExecuteQuery (query, state) {
  const currentQuery = getCurrentQuery(state);
  if (!currentQuery) return true;
  if (currentQuery.isExecuting) return false;
  return true;
}

const executingQueries = {};

function executeQuery (query, isDefaultSelect = false, dbConnection, queryId) {
  return async (dispatch, getState) => {
    dispatch({ type: EXECUTE_QUERY_REQUEST, query, isDefaultSelect });
    try {
      const dbConn = dbConnection || getCurrentDBConn(getState());
      executingQueries[queryId] = dbConn.query(query);
      const remoteResult = await executingQueries[queryId].execute();

      // Remove any "reference" to the remote IPC object
      const results = cloneDeep(remoteResult);

      dispatch({ type: EXECUTE_QUERY_SUCCESS, query, results });
    } catch (error) {
      dispatch({ type: EXECUTE_QUERY_FAILURE, query, error });
    } finally {
      delete executingQueries[queryId];
    }
  };
}


export function cancelQuery (queryId) {
  return async (dispatch) => {
    dispatch({ type: CANCEL_QUERY_REQUEST, queryId });
    try {
      if (executingQueries[queryId]) {
        await executingQueries[queryId].cancel();
      }

      dispatch({ type: CANCEL_QUERY_SUCCESS, queryId });
    } catch (error) {
      dispatch({ type: CANCEL_QUERY_FAILURE, queryId, error });
    } finally {
      delete executingQueries[queryId];
    }
  };
}


function stringifyResultToCSV(rows) {
  if (!rows.length) {
    return '';
  }

  const header = Object.keys(rows[0]).reduce((_header, col) => {
    _header[col] = col; // eslint-disable-line no-param-reassign
    return _header;
  }, {});

  const data = [
    header,
    ...rowsValuesToString(rows),
  ];

  return new Promise((resolve, reject) => {
    csvStringify(data, (err, csv) => {
      if (err) {
        reject(err);
      } else {
        resolve(csv);
      }
    });
  });
}


function getCurrentQuery(state) {
  return state.queries.queriesById[state.queries.currentQueryId];
}

function needNewQuery(currentState, database, queryDefaultSelect) {
  const currentQuery = getCurrentQuery(currentState);
  if (!currentQuery) {
    return false;
  }

  const queryIsDifferentDB = currentQuery.database !== database;
  const queryIsNotDefault = currentQuery.query !== queryDefaultSelect;
  const queryIsNotEmpty = !!trim(currentQuery.query);

  return queryIsDifferentDB || (queryIsNotDefault && queryIsNotEmpty);
}
