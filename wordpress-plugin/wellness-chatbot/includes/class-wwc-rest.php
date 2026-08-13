<?php
/**
 * REST proxy for the widget (spec §1.2, §11).
 *
 * The widget talks only to WordPress. WordPress signs and forwards to the
 * backend. The shared secret never reaches the browser, and the backend can
 * only be reached by this specific site.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Rest {

	const NAMESPACE = 'wellness-chatbot/v1';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		$public_args = array(
			'permission_callback' => '__return_true', // storefront visitors are anonymous
		);

		register_rest_route(
			self::NAMESPACE,
			'/session',
			array_merge(
				$public_args,
				array(
					'methods'  => WP_REST_Server::CREATABLE,
					'callback' => array( __CLASS__, 'start_session' ),
				)
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/message',
			array_merge(
				$public_args,
				array(
					'methods'  => WP_REST_Server::CREATABLE,
					'callback' => array( __CLASS__, 'message' ),
					'args'     => array(
						'session_id' => array( 'type' => 'string', 'required' => true ),
						'token'      => array( 'type' => 'string', 'required' => true ),
						'message'    => array( 'type' => 'string', 'required' => true ),
					),
				)
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/questionnaire',
			array_merge(
				$public_args,
				array(
					'methods'  => WP_REST_Server::READABLE,
					'callback' => array( __CLASS__, 'questionnaire' ),
				)
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/feedback',
			array_merge(
				$public_args,
				array(
					'methods'  => WP_REST_Server::CREATABLE,
					'callback' => array( __CLASS__, 'feedback' ),
				)
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/event',
			array_merge(
				$public_args,
				array(
					'methods'  => WP_REST_Server::CREATABLE,
					'callback' => array( __CLASS__, 'event' ),
				)
			)
		);
	}

	/**
	 * Anonymous storefront visitors have no nonce, so abuse is held back by the
	 * backend's per-IP and per-session rate limits plus a same-origin check.
	 */
	private static function reject_if_offsite( WP_REST_Request $request ) {
		$referer = (string) $request->get_header( 'referer' );
		if ( '' === $referer ) {
			return null; // some privacy setups strip it; the rate limiter still applies
		}
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		$from = wp_parse_url( $referer, PHP_URL_HOST );
		if ( $home && $from && ! hash_equals( (string) $home, (string) $from ) ) {
			return new WP_Error( 'wwc_offsite', __( 'Request did not originate from this store.', 'wellness-chatbot' ), array( 'status' => 403 ) );
		}
		return null;
	}

	public static function start_session( WP_REST_Request $request ) {
		$blocked = self::reject_if_offsite( $request );
		if ( $blocked ) {
			return $blocked;
		}

		$response = WWC_Backend_Client::post(
			'/api/chat/session',
			array( 'language' => sanitize_key( (string) $request->get_param( 'language' ) ) )
		);

		return self::respond( $response );
	}

	public static function message( WP_REST_Request $request ) {
		$blocked = self::reject_if_offsite( $request );
		if ( $blocked ) {
			return $blocked;
		}

		$payload = array(
			'session_id' => sanitize_text_field( (string) $request->get_param( 'session_id' ) ),
			'token'      => sanitize_text_field( (string) $request->get_param( 'token' ) ),
			'message'    => wp_strip_all_tags( (string) $request->get_param( 'message' ) ),
		);

		$answer = $request->get_param( 'answer' );
		if ( is_array( $answer ) && isset( $answer['key'] ) ) {
			$payload['answer'] = array(
				'key'   => sanitize_key( (string) $answer['key'] ),
				'value' => is_array( $answer['value'] )
					? array_map( 'sanitize_text_field', $answer['value'] )
					: sanitize_text_field( (string) $answer['value'] ),
			);
		}

		return self::respond( WWC_Backend_Client::post( '/api/chat/message', $payload, array( 'timeout' => 60 ) ) );
	}

	public static function questionnaire() {
		$cached = get_transient( 'wwc_questionnaire_config' );
		if ( false !== $cached ) {
			return rest_ensure_response( $cached );
		}

		$response = WWC_Backend_Client::get( '/api/questionnaire/config' );
		if ( is_wp_error( $response ) ) {
			return self::respond( $response );
		}

		set_transient( 'wwc_questionnaire_config', $response, 10 * MINUTE_IN_SECONDS );
		return rest_ensure_response( $response );
	}

	public static function feedback( WP_REST_Request $request ) {
		$blocked = self::reject_if_offsite( $request );
		if ( $blocked ) {
			return $blocked;
		}

		return self::respond(
			WWC_Backend_Client::post(
				'/api/feedback',
				array(
					'session_id' => sanitize_text_field( (string) $request->get_param( 'session_id' ) ),
					'token'      => sanitize_text_field( (string) $request->get_param( 'token' ) ),
					'message_id' => sanitize_text_field( (string) $request->get_param( 'message_id' ) ),
					'rating'     => 'up' === $request->get_param( 'rating' ) ? 'up' : 'down',
					'reason'     => wp_strip_all_tags( (string) $request->get_param( 'reason' ) ),
				)
			)
		);
	}

	public static function event( WP_REST_Request $request ) {
		$blocked = self::reject_if_offsite( $request );
		if ( $blocked ) {
			return $blocked;
		}

		$payload = $request->get_param( 'payload' );

		return self::respond(
			WWC_Backend_Client::post(
				'/api/chat/event',
				array(
					'session_id' => sanitize_text_field( (string) $request->get_param( 'session_id' ) ),
					'token'      => sanitize_text_field( (string) $request->get_param( 'token' ) ),
					'name'       => sanitize_key( (string) $request->get_param( 'name' ) ),
					'payload'    => is_array( $payload ) ? array_map( 'sanitize_text_field', array_map( 'strval', $payload ) ) : null,
				),
				array( 'timeout' => 10 )
			)
		);
	}

	/**
	 * @param array|WP_Error $response Backend response.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function respond( $response ) {
		if ( is_wp_error( $response ) ) {
			$status = 502;
			$data   = $response->get_error_data();
			if ( is_array( $data ) && isset( $data['status'] ) ) {
				$status = (int) $data['status'];
			}
			return new WP_Error( $response->get_error_code(), $response->get_error_message(), array( 'status' => $status ) );
		}
		return rest_ensure_response( $response );
	}
}
