/**
 * Wellness Chatbot admin behaviour.
 * Deliberately tiny — the admin screens are server-rendered forms.
 */
( function () {
	'use strict';

	var strings = ( window.WWC_ADMIN && window.WWC_ADMIN.strings ) || {};

	function confirmBefore( selector, message ) {
		document.querySelectorAll( selector ).forEach( function ( button ) {
			button.addEventListener( 'click', function ( event ) {
				if ( ! window.confirm( message ) ) {
					event.preventDefault();
				}
			} );
		} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		confirmBefore(
			'.wwc-confirm-reject',
			strings.confirmReject || 'Reject this AI draft?'
		);
		confirmBefore(
			'.wwc-confirm-delete',
			'Delete this entry? This cannot be undone.'
		);

		// Approving is the consequential action on this screen, so make the
		// double-submit impossible rather than merely unlikely.
		document.querySelectorAll( '.wwc-review-form' ).forEach( function ( form ) {
			form.addEventListener( 'submit', function () {
				form.querySelectorAll( 'button[type="submit"]' ).forEach( function ( button ) {
					button.disabled = true;
				} );
				var pending = form.querySelector( '.wwc-review-actions' );
				if ( pending ) {
					var note = document.createElement( 'span' );
					note.className = 'wwc-saving';
					note.textContent = ' ' + ( strings.saving || 'Saving…' );
					pending.appendChild( note );
				}
			} );
		} );
	} );
} )();
