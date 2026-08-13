<?php
/**
 * Signed server-to-server client for the chatbot backend (spec §2, §11).
 *
 * Everything the browser sends goes through here, so the shared secret and the
 * admin's capabilities are asserted on the server and never exposed to a page.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Backend_Client {

	/**
	 * POSTs a signed JSON request.
	 *
	 * @param string $path    Backend path, e.g. '/api/chat/message'.
	 * @param array  $payload Body.
	 * @param array  $args    Optional: 'timeout', 'blocking'.
	 * @return array|WP_Error Decoded response body.
	 */
	public static function post( $path, array $payload = array(), array $args = array() ) {
		return self::request( 'POST', $path, $payload, $args );
	}

	/**
	 * GETs a signed request. The signature covers an empty body plus the
	 * timestamp, which is enough to prove the call came from this site.
	 *
	 * @param string $path  Backend path.
	 * @param array  $query Query args.
	 * @return array|WP_Error
	 */
	public static function get( $path, array $query = array() ) {
		if ( ! empty( $query ) ) {
			$path .= ( false === strpos( $path, '?' ) ? '?' : '&' ) . http_build_query( $query );
		}
		return self::request( 'GET', $path, null );
	}

	private static function request( $method, $path, $payload, array $args = array() ) {
		$base = WWC_Settings::backend_url();
		if ( '' === $base ) {
			return new WP_Error( 'wwc_not_configured', __( 'The chatbot backend URL has not been set.', 'wellness-chatbot' ) );
		}

		$secret = WWC_Settings::shared_secret();
		if ( '' === $secret ) {
			return new WP_Error( 'wwc_no_secret', __( 'The chatbot shared secret has not been set.', 'wellness-chatbot' ) );
		}

		$body      = null === $payload ? '' : wp_json_encode( $payload );
		$timestamp = (string) time();
		$signature = hash_hmac( 'sha256', $timestamp . '.' . $body, $secret );

		$headers = array(
			'Content-Type'          => 'application/json',
			'X-Wellness-Timestamp'  => $timestamp,
			'X-Wellness-Signature'  => $signature,
			'X-Wellness-Site'       => home_url(),
		);

		// Identity travels with admin calls so the backend can log who acted and
		// enforce the pharmacist gate server-side (spec §11).
		if ( is_user_logged_in() ) {
			$user                            = wp_get_current_user();
			$headers['X-Wellness-User']      = $user->user_login;
			$headers['X-Wellness-Pharmacist'] = current_user_can( WWC_Roles::CAP_PHARMACIST ) ? '1' : '0';
		}

		$response = wp_remote_request(
			$base . $path,
			array(
				'method'   => $method,
				'headers'  => $headers,
				'body'     => '' === $body ? null : $body,
				'timeout'  => isset( $args['timeout'] ) ? (int) $args['timeout'] : 30,
				'blocking' => isset( $args['blocking'] ) ? (bool) $args['blocking'] : true,
			)
		);

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = wp_remote_retrieve_response_code( $response );
		$raw  = wp_remote_retrieve_body( $response );
		$data = json_decode( $raw, true );

		if ( $code >= 400 ) {
			$message = is_array( $data ) && isset( $data['error'] )
				? $data['error']
				: sprintf( /* translators: %d: HTTP status code. */ __( 'The chatbot backend returned HTTP %d.', 'wellness-chatbot' ), $code );

			return new WP_Error( 'wwc_backend_error', $message, array( 'status' => $code, 'body' => $data ) );
		}

		return is_array( $data ) ? $data : array();
	}

	/**
	 * Fire-and-forget notification, used by the product webhooks so saving a
	 * product in wp-admin is never slowed down by the chatbot.
	 *
	 * @param string $path    Backend path.
	 * @param array  $payload Body.
	 */
	public static function notify( $path, array $payload ) {
		self::request( 'POST', $path, $payload, array( 'blocking' => false, 'timeout' => 5 ) );
	}
}
